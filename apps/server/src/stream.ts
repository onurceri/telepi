// WebSocket stream: replay ops after a rev, then live ops. Ping/pong liveness. Origin check.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { routes, type ServerMessage, type StreamOp } from "@telepi/contract";
import type { Config } from "./config";
import { HttpError } from "./http";
import type { State } from "./state";

const PING_MS = 25_000;
const DEAD_MS = 60_000;
const REPLAY_CHUNK = 500;
const MAX_BUFFERED = 8 * 1024 * 1024;

const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isAllowedOrigin(origin: string | undefined, config: Config): boolean {
  // Browsers always send Origin on a WebSocket upgrade. Non-browser clients do not, and still need a session cookie.
  if (origin === undefined) return true;
  return origin === config.publicOrigin || DEV_ORIGIN.test(origin);
}

export class Stream {
  private sockets = new Map<string, Set<WebSocket>>();

  constructor(private state: State, private config: Config) {}

  closeDevice(deviceId: string): void {
    for (const socket of this.sockets.get(deviceId) ?? []) socket.close(4401, "revoked");
    this.sockets.delete(deviceId);
  }

  closeAll(): void {
    for (const set of this.sockets.values()) for (const socket of set) socket.close(1001, "shutdown");
  }

  register(app: FastifyInstance, deviceIdOf: (req: FastifyRequest) => string): void {
    app.get(
      routes.stream,
      {
        websocket: true,
        preValidation: async (req) => {
          if (!isAllowedOrigin(req.headers.origin, this.config)) throw new HttpError("invalid", "Origin not allowed.");
        },
      },
      (socket, req) => this.attach(socket, deviceIdOf(req), req),
    );
  }

  private attach(socket: WebSocket, deviceId: string, req: FastifyRequest): void {
    const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
    const afterRaw = (req.query as Record<string, string | undefined>).after;
    const after = afterRaw === undefined ? this.state.rev : Number(afterRaw);

    const replay = Number.isInteger(after) ? this.state.opsAfter(after) : null;
    if (!replay) {
      send({ type: "resync" });
      socket.close(4000, "resync");
      return;
    }

    const set = this.sockets.get(deviceId) ?? new Set();
    set.add(socket);
    this.sockets.set(deviceId, set);

    // Replay and subscribe in the same tick so no op falls between them.
    for (let i = 0; i < replay.length; i += REPLAY_CHUNK) send({ type: "ops", ops: replay.slice(i, i + REPLAY_CHUNK) });
    let queue: StreamOp[] = [];
    const unsubscribe = this.state.subscribe((op) => {
      if (queue.push(op) > 1) return;
      queueMicrotask(() => {
        const ops = queue;
        queue = [];
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > MAX_BUFFERED) return socket.terminate();
        send({ type: "ops", ops });
      });
    });

    let lastPong = Date.now();
    socket.on("message", () => {
      lastPong = Date.now();
    });
    const timer = setInterval(() => {
      if (Date.now() - lastPong > DEAD_MS) return socket.terminate();
      if (socket.readyState === socket.OPEN) send({ type: "ping" });
    }, PING_MS);

    const cleanup = () => {
      clearInterval(timer);
      unsubscribe();
      set.delete(socket);
      if (set.size === 0) this.sockets.delete(deviceId);
    };
    socket.on("close", cleanup);
    socket.on("error", () => socket.terminate());
  }
}
