import { randomUUID, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { MessageQueue, type QueueStatus } from "../core/queue.js";
import { SessionManager, type EventBus } from "../core/session.js";
import type { SurfaceId } from "../core/wrapper.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const WS_GUID = "258EAFA5-E914-47DA-95CA-5AB5DC19B6B9";
const OP_TEXT = 0x01;
const OP_CLOSE = 0x08;
const OP_PING = 0x09;
const OP_PONG = 0x0a;

/** Minimal WebSocket connection wrapper. */
class WebSocketConnection {
  private _socket: Duplex;
  private _closed = false;

  constructor(socket: Duplex) {
    this._socket = socket;
  }

  /** Send a text frame (unmasked). */
  send(data: string): void {
    if (this._closed) return;
    const payload = Buffer.from(data, "utf-8");
    this._sendRaw(OP_TEXT, payload);
  }

  /** Initiate close handshake. */
  close(code = 1000, reason = ""): void {
    if (this._closed) return;
    this._closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    if (reason) payload.write(reason, 2);
    this._sendRaw(OP_CLOSE, payload);
    this._socket.end();
  }

  /** Whether the socket has been closed. */
  get closed(): boolean {
    return this._closed || this._socket.destroyed;
  }

  /** Send a raw frame with the given opcode and payload. */
  private _sendRaw(opcode: number, payload: Buffer): void {
    if (this._closed) return;
    const frame = this._buildFrame(opcode, payload);
    try {
      this._socket.write(frame);
    } catch {
      this.close();
    }
  }

  private _buildFrame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let header: Buffer;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
  }
}

/** Perform WebSocket upgrade handshake. Returns the accept key. */
function computeAcceptKey(key: string): string {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

/** A connected WebSocket client with its event subscription. */
interface WsClient {
  ws: WebSocketConnection;
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
 * - GET  /api/status  — queue status + session info
 * - WS   /api/ws      — subscribe to streaming deltas
 *
 * CORS is enabled for localhost origins.
 */
export class Gateway {
  private _server: Server | null = null;
  private _wsClients = new Set<WsClient>();
  private _messageQueue: MessageQueue;
  private _sessionManager: SessionManager;
  private _eventBus: EventBus<AgentSessionEvent>;

  constructor(sessionManager: SessionManager, messageQueue: MessageQueue) {
    this._sessionManager = sessionManager;
    this._messageQueue = messageQueue;
    this._eventBus = sessionManager.onEvent;
  }

  /** Start the HTTP server. */
  async start(config: GatewayConfig): Promise<void> {
    const server = createServer((req, res) => this._handleRequest(req, res));
    server.on("upgrade", (req, socket, head) =>
      this._handleUpgrade(req, socket, head),
    );

    return new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        this._server = server;
        console.log(
          `Gateway listening on http://${config.host}:${config.port}`,
        );
        resolve();
      });
    });
  }

  /** Graceful stop: close all WS connections, then the server. */
  async stop(): Promise<void> {
    for (const client of this._wsClients) {
      client.unsub();
      client.ws.close(1001, "Server shutting down");
    }
    this._wsClients.clear();

    if (this._server) {
      return new Promise<void>((resolve) => {
        this._server!.close(() => resolve());
        this._server!.closeAllConnections?.();
      });
    }
  }

  private _handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    this._setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      if (method === "POST" && url === "/api/message") {
        this._handlePostMessage(req, res);
      } else if (method === "GET" && url === "/api/status") {
        this._handleGetStatus(req, res);
      } else {
        this._jsonError(res, 404, "Not found");
      }
    } catch (err) {
      console.error("Gateway: request handler error", err);
      this._jsonError(res, 500, "Internal server error");
    }
  }

  /** POST /api/message — enqueue a message. */
  private async _handlePostMessage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await this._readBody(req);
    let parsed: { text?: string; surface?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      this._jsonError(res, 400, "Invalid JSON body");
      return;
    }

    const text = parsed.text?.trim();
    if (!text) {
      this._jsonError(res, 400, "Field 'text' is required and must be non-empty");
      return;
    }

    const surfaceRaw = parsed.surface?.trim() ?? "dashboard";
    const surface = this._normalizeSurface(surfaceRaw);

    const messageId = randomUUID();

    this._messageQueue.enqueue(text, surface).catch((err) => {
      console.error("Gateway: enqueue error", err);
    });

    const response = {
      id: messageId,
      surface,
      text,
      status: "queued" as const,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  }

  /** GET /api/status — return queue and session info. */
  private _handleGetStatus(
    _req: IncomingMessage,
    res: ServerResponse,
  ): void {
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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  }

  private _handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    _head: Buffer,
  ): void {
    const url = req.url ?? "/";

    if (url !== "/api/ws") {
      socket.write(
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"] as string;
    if (!key) {
      socket.write(
        "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }

    const accept = computeAcceptKey(key);
    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n");

    socket.write(responseHeaders);

    const ws = new WebSocketConnection(socket);
    const clientId = randomUUID();

    const unsub = this._eventBus.on("session_event", (event: AgentSessionEvent) => {
      if (ws.closed) return;

      const type = event.type;
      if (
        type === "agent_start" ||
        type === "agent_end" ||
        type === "agent_settled" ||
        type === "turn_start" ||
        type === "turn_end" ||
        type === "message_start" ||
        type === "message_update" ||
        type === "message_end" ||
        type === "tool_execution_start" ||
        type === "tool_execution_update" ||
        type === "tool_execution_end"
      ) {
        ws.send(JSON.stringify(event));
      }
    });

    const client: WsClient = { ws, id: clientId, unsub };
    this._wsClients.add(client);

    ws.send(JSON.stringify({ type: "connected", clientId }));

    socket.on("close", () => {
      client.unsub();
      this._wsClients.delete(client);
    });

    socket.on("error", () => {
      client.unsub();
      this._wsClients.delete(client);
    });

    this._startWsReadLoop(socket, ws);
  }

  /**
   * Read frames from the socket.
   *
   * Handles Ping → Pong reply, Close → tear down, Text → ignored
   * (server-to-client only).
   */
  private _startWsReadLoop(socket: Duplex, ws: WebSocketConnection): void {
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const masked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLen = masked ? 4 : 0;
        const totalLen = offset + maskLen + payloadLen;
        if (buffer.length < totalLen) return;

        let mask: Buffer | null = null;
        let payloadStart = offset;
        if (masked) {
          mask = buffer.subarray(offset, offset + 4);
          payloadStart = offset + 4;
        }

        const payload = Buffer.from(
          buffer.subarray(payloadStart, payloadStart + payloadLen),
        );

        if (mask) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }

        buffer = buffer.subarray(totalLen);

        switch (opcode) {
          case OP_PING: {
            // Echo payload back as Pong (FIN + opcode + length + payload).
            const pongFrame = Buffer.alloc(2 + payload.length);
            pongFrame[0] = 0x80 | OP_PONG;
            pongFrame[1] = payload.length;
            if (payload.length > 0) payload.copy(pongFrame, 2);
            socket.write(pongFrame);
            break;
          }
          case OP_CLOSE: {
            ws.close();
            break;
          }
          case OP_TEXT:
          default: {
            // Ignored — we're server-to-client only.
            break;
          }
        }
      }
    });
  }

  private _setCorsHeaders(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  private _normalizeSurface(raw: string): SurfaceId {
    switch (raw.toLowerCase()) {
      case "discord":
        return "discord";
      case "launcher":
      case "vicinae":
        return "launcher";
      case "dashboard":
        return "dashboard";
      default:
        return "cli";
    }
  }

  private _jsonError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }

  private _readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
}