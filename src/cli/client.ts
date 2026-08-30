import { createInterface } from "node:readline";
import WebSocket from "ws";

interface PostMessageResponse {
  id: string;
  surface: string;
  text: string;
  status: "queued";
}

/**
 * Interactive CLI client that connects to the gateway via HTTP + WS.
 *
 * - POSTs messages to /api/message
 * - Subscribes to /api/ws for streaming deltas and prints them to terminal
 * - Simple readline loop for interactive testing
 */
export class CliTestClient {
  private gatewayUrl: string;
  private surface: string;

  /**
   * @param gatewayUrl Base URL of the gateway, e.g. `http://localhost:8080`.
   * @param surface    Surface identifier to send with each message (default "cli").
   */
  constructor(gatewayUrl: string, surface = "cli") {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, "");
    this.surface = surface;
  }

  /**
   * Connect to the gateway, subscribe to WS events, then start the
   * readline input loop.  Each line of input is POSTed to
   * /api/message; streaming deltas arrive via the WS connection.
   *
   * The loop exits on EOF (Ctrl+D), `/quit`, or `/exit`.
   */
  async run(): Promise<void> {
    const wsUrl = this.gatewayUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");
    const wsEndpoint = `${wsUrl}/api/ws`;

    console.log(`Connecting to WS: ${wsEndpoint}`);

    const ws = new WebSocket(wsEndpoint);

    ws.on("open", () => {
      console.log("Connected — type a message and press Enter");
      this._startReadline(ws);
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      try {
        const event = JSON.parse(raw);
        this._printEvent(event);
      } catch {
        console.log(`[WS RAW] ${raw}`);
      }
    });

    ws.on("error", (err) => {
      console.error(`WS error: ${err.message}`);
    });

    ws.on("close", (code, reason) => {
      const msg = reason?.toString() ?? "unknown";
      console.log(`\nWS closed (${code}: ${msg})`);
      process.exit(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Readline loop
  // ---------------------------------------------------------------------------

  private _startReadline(ws: WebSocket): void {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    rl.prompt();

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit") {
        rl.close();
        ws.close();
        return;
      }

      try {
        const response = await this._postMessage(trimmed, this.surface);
        console.log(`[sent] id=${response.id} status=${response.status}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[error] ${msg}`);
      }

      rl.prompt();
    });

    rl.on("close", () => {
      ws.close();
      process.exit(0);
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async _postMessage(
    text: string,
    surface: string,
  ): Promise<PostMessageResponse> {
    const url = new URL("/api/message", this.gatewayUrl);

    const body = JSON.stringify({ text, surface });

    const res = await fetch(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`POST /api/message failed (${res.status}): ${errText}`);
    }

    return res.json() as Promise<PostMessageResponse>;
  }

  // ---------------------------------------------------------------------------
  // Event printing
  // ---------------------------------------------------------------------------

  private _printEvent(event: Record<string, unknown>): void {
    const type = event.type as string | undefined;

    switch (type) {
      case "connected":
        console.log(`[WS] clientId = ${event.clientId as string}`);
        break;

      case "agent_start":
        console.log("\n[agent] session started");
        break;

      case "agent_end":
        console.log("[agent] session ended");
        break;

      case "agent_settled":
        console.log("[agent] settled");
        break;

      case "turn_start":
        console.log("\n[turn] start");
        break;

      case "turn_end":
        console.log("[turn] end");
        break;

      case "message_start":
        console.log("\n[assistant] ");
        break;

      case "message_update":
        if (typeof event.delta === "string") {
          process.stdout.write(event.delta);
        }
        break;

      case "message_end":
        console.log("\n[message complete]");
        break;

      case "tool_execution_start":
        console.log(`\n[tool] ${(event.name as string) ?? ""} start`);
        break;

      case "tool_execution_update":
        if (event.output !== undefined) {
          console.log(`[tool] ${String(event.output)}`);
        }
        break;

      case "tool_execution_end":
        console.log(`[tool] ${(event.name as string) ?? ""} end`);
        break;

      default:
        console.log(`[event] ${type}`, event);
    }
  }
}