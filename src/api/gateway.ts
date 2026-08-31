import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MessageQueue, type QueueStatus } from '../core/queue.js';
import { SessionManager, type EventBus } from '../core/session.js';
import type { SurfaceId } from '../core/wrapper.js';
import { WindowManager } from '../core/window/window-manager.js';
import type { WindowStats } from '../core/window/types.js';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** A connected WebSocket client with its event subscription. */
interface WsClient {
  ws: WebSocket;
  id: string;
  /** Unsubscribe function for the session event bus. */
  unsub: () => void;
}

export interface GatewayConfig {
  host: string;
  port: number;
}

/**
 * HTTP + WebSocket gateway for surface clients.
 *
 * - POST /api/message — enqueue a message (returns message ID immediately)
 * - POST /api/compact — trigger a manual compaction epoch
 * - GET  /api/status  — queue status + session info
 * - WS   /api/ws      — subscribe to streaming deltas and window stats
 *
 * After each turn and after every compaction epoch a {@link WindowStats}
 * message is broadcast on the WS channel as `{ type: "window_stats", data: WindowStats }`
 * so surfaces can show a busy/compacting state.
 *
 * CORS is enabled for localhost origins.
 */
export class Gateway {
  private _server: Server | null = null;
  private _wsServer: WebSocketServer | null = null;
  private _wsClients = new Set<WsClient>();
  private _messageQueue: MessageQueue;
  private _sessionManager: SessionManager;
  private _eventBus: EventBus<AgentSessionEvent>;
  private _windowManager: WindowManager | null = null;

  constructor(
    sessionManager: SessionManager,
    messageQueue: MessageQueue,
    windowManager?: WindowManager,
  ) {
    this._sessionManager = sessionManager;
    this._messageQueue = messageQueue;
    this._eventBus = sessionManager.onEvent;
    if (windowManager) {
      this._windowManager = windowManager;
      this._windowManager.setOnStatsUpdate((stats) => this._broadcastWindowStats(stats));
    }
  }

  /** Start the HTTP server. */
  async start(config: GatewayConfig): Promise<void> {
    const server = createServer((req, res) => this._handleRequest(req, res));

    const wsServer = new WebSocketServer({ noServer: true });
    wsServer.on('connection', (ws, req) => this._handleWsConnection(ws, req));

    server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '/';
      if (url === '/api/ws') {
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });

    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        this._server = server;
        this._wsServer = wsServer;
        console.log(`Gateway listening on http://${config.host}:${config.port}`);
        resolve();
      });
    });
  }

  /** Graceful stop: close all WS connections, then the server. */
  async stop(): Promise<void> {
    for (const client of this._wsClients) {
      client.unsub();
      client.ws.close(1001, 'Server shutting down');
    }
    this._wsClients.clear();

    this._wsServer?.close();
    if (this._server) {
      return new Promise<void>((resolve) => {
        this._server!.close(() => resolve());
        this._server!.closeAllConnections?.();
      });
    }
  }

  private _handleRequest(req: IncomingMessage, res: ServerResponse): void {
    this._setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    try {
      if (method === 'POST' && url === '/api/message') {
        this._handlePostMessage(req, res);
      } else if (method === 'GET' && url === '/api/status') {
        this._handleGetStatus(req, res);
      } else if (method === 'POST' && url === '/api/compact') {
        this._handlePostCompact(req, res);
      } else {
        this._jsonError(res, 404, 'Not found');
      }
    } catch (err) {
      console.error('Gateway: request handler error', err);
      this._jsonError(res, 500, 'Internal server error');
    }
  }

  /** POST /api/message — enqueue a message. */
  private async _handlePostMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this._readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      this._jsonError(res, 400, 'Invalid JSON body');
      return;
    }

    if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
      this._jsonError(res, 400, "Field 'text' is required and must be a non-empty string");
      return;
    }
    const text: string = parsed.text.trim();

    let surfaceRaw: string;
    if (typeof parsed.surface === 'string') {
      surfaceRaw = parsed.surface.trim() || 'dashboard';
    } else {
      surfaceRaw = 'dashboard';
    }
    const surface = this._normalizeSurface(surfaceRaw);

    const messageId = randomUUID();

    this._messageQueue.enqueue(text, surface).catch((err) => {
      console.error('Gateway: enqueue error', err);
    });

    const response = {
      id: messageId,
      surface,
      text,
      status: 'queued' as const,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /** GET /api/status — return queue and session info. */
  private _handleGetStatus(_req: IncomingMessage, res: ServerResponse): void {
    const queueStatus: QueueStatus = this._messageQueue.getStatus();

    const session = this._sessionManager.session;
    const sessionInfo = {
      isStreaming: session?.isStreaming ?? false,
      isIdle: session?.isIdle ?? true,
      sessionId: session?.sessionId ?? null,
      sessionFile: session?.sessionFile ?? null,
    };

    const status = {
      queue: queueStatus,
      session: sessionInfo,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  /** POST /api/compact — trigger manual compaction. */
  private async _handlePostCompact(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this._windowManager) {
      this._jsonError(res, 503, 'Window manager not available (session not started)');
      return;
    }

    try {
      // Respond immediately so the client knows the request was accepted.
      // Compaction may take a moment; the WS stats broadcast will signal
      // completion.
      const stats = this._windowManager.getStats();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'compacting',
          stats,
        }),
      );

      // Fire compaction in the background.
      this._windowManager.manualCompact().catch((err) => {
        console.error('Gateway: manual compact failed', err);
      });
    } catch (err) {
      console.error('Gateway: /compact error', err);
      this._jsonError(res, 500, 'Internal server error');
    }
  }

  /** Broadcast a window stats snapshot to every connected WS client. */
  private _broadcastWindowStats(stats: WindowStats): void {
    const message = JSON.stringify({ type: 'window_stats', data: stats });
    for (const client of this._wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }

  private _handleWsConnection(ws: WebSocket, _req: IncomingMessage): void {
    const clientId = randomUUID();

    const unsub = this._eventBus.on('session_event', (event: AgentSessionEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const type = event.type;
      if (
        type === 'agent_start' ||
        type === 'agent_end' ||
        type === 'agent_settled' ||
        type === 'turn_start' ||
        type === 'turn_end' ||
        type === 'message_start' ||
        type === 'message_update' ||
        type === 'message_end' ||
        type === 'tool_execution_start' ||
        type === 'tool_execution_update' ||
        type === 'tool_execution_end' ||
        type === 'compaction_start' ||
        type === 'compaction_end'
      ) {
        ws.send(JSON.stringify(event));
      }
    });

    const client: WsClient = { ws, id: clientId, unsub };
    this._wsClients.add(client);

    ws.send(JSON.stringify({ type: 'connected', clientId }));

    ws.on('close', () => {
      client.unsub();
      this._wsClients.delete(client);
    });

    ws.on('error', () => {
      client.unsub();
      this._wsClients.delete(client);
    });
  }

  private _setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  private _normalizeSurface(raw: string): SurfaceId {
    switch (raw.toLowerCase()) {
      case 'discord':
        return 'discord';
      case 'launcher':
      case 'vicinae':
        return 'launcher';
      case 'dashboard':
        return 'dashboard';
      default:
        return 'cli';
    }
  }

  private _jsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }

  private _readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }
}
