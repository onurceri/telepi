// Boot, snapshot, WebSocket stream, backoff and liveness.
import { CONTRACT_VERSION, ServerMessage, SessionResponse, Snapshot, routes, type StreamOp } from "@telepi/contract";
import type { Cache } from "./cache";
import type { Events } from "./events";
import { HttpError, Unreachable, call, isUnauthenticated } from "./http";
import { upsertById, type Store } from "./store";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const DEAD_AFTER_MS = 60_000;
/** The server pings every 25 s. Coming back to the foreground after longer than this means the socket may be dead. */
const STALE_AFTER_MS = 35_000;

export interface Sync {
  /** Run the boot sequence (session, snapshot, stream). Does nothing while one is already running. */
  connect(): void;
  /** Skip the backoff wait and try now. */
  retryNow(): void;
  /** Something learned elsewhere (a failed command) says the server cannot be reached. */
  markUnreachable(): void;
  /** Forget the synced position (after the cache was dropped). */
  reset(): void;
}

interface Options {
  store: Store;
  cache: Cache;
  events: Events;
  /** The stream is open and live. */
  onOnline(): void;
  /** The server speaks a newer contract than this copy of the app. */
  onStale?(): void;
}

export function createSync(opts: Options): Sync {
  const { store, cache, events, onOnline } = opts;
  let rev = 0;
  let hasSnapshot = false;
  let running = false;
  let ws: WebSocket | null = null;
  let lastMessageAt = 0;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function persistNow(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    const s = store.get();
    void cache.saveMeta({
      contractVersion: CONTRACT_VERSION,
      rev,
      lastSyncedAt: s.lastSyncedAt,
      device: s.device,
      projects: s.projects,
      tasks: s.tasks,
      requests: s.requests,
    });
  }

  function schedulePersist(): void {
    persistTimer ??= setTimeout(persistNow, 250);
  }

  function applyOps(ops: StreamOp[]): void {
    const s = store.get();
    let { projects, tasks, requests } = s;
    for (const op of ops) {
      if (op.rev <= rev) continue; // already reflected
      rev = op.rev;
      switch (op.op) {
        case "project_upsert":
          projects = upsertById(projects, op.project);
          break;
        case "task_upsert":
          tasks = upsertById(tasks, op.task);
          break;
        case "request_upsert":
          requests = upsertById(requests, op.request);
          break;
        case "task_event":
          events.ingest(op.event);
          break;
      }
    }
    store.set({ projects, tasks, requests, lastSyncedAt: Date.now() });
    schedulePersist();
  }

  // --- socket -------------------------------------------------------------

  function clearWatchdog(): void {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  }

  function armWatchdog(): void {
    clearWatchdog();
    watchdog = setTimeout(onSocketLost, DEAD_AFTER_MS);
  }

  function teardown(): void {
    clearWatchdog();
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
    ws = null;
  }

  function onSocketLost(): void {
    teardown();
    if (store.get().connection !== "unauthenticated") store.set({ connection: "unreachable" });
    scheduleReconnect();
  }

  function openSocket(): void {
    teardown();
    const url = new URL(routes.stream, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("after", String(rev));
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      lastMessageAt = Date.now();
      armWatchdog();
      store.set({ connection: "online" });
      onOnline();
    };
    socket.onmessage = (ev) => {
      lastMessageAt = Date.now();
      armWatchdog();
      let msg: ServerMessage;
      try {
        const parsed = ServerMessage.safeParse(JSON.parse(String(ev.data)));
        if (!parsed.success) return;
        msg = parsed.data;
      } catch {
        return;
      }
      if (msg.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "ops") {
        applyOps(msg.ops);
      } else {
        // The rev is too old: start over from a fresh snapshot.
        teardown();
        hasSnapshot = false;
        void connect();
      }
    };
    socket.onclose = onSocketLost;
    socket.onerror = () => {}; // onclose follows
  }

  // --- boot ---------------------------------------------------------------

  async function connect(): Promise<void> {
    if (running) return;
    running = true;
    clearRetry();
    try {
      const session = await call("GET", routes.session, { schema: SessionResponse });
      // The server is newer than this copy of the app: take the new app as soon as it can be had.
      if (session.contractVersion > CONTRACT_VERSION) opts.onStale?.();
      if (session.contractVersion !== CONTRACT_VERSION) {
        await cache.clearAll();
        events.reset();
        hasSnapshot = false;
        rev = 0;
        store.set({ lastSyncedAt: null, projects: [], tasks: [], requests: [] });
      }
      if (!hasSnapshot) {
        const snap = await call("GET", routes.snapshot, { schema: Snapshot });
        if (snap.contractVersion !== CONTRACT_VERSION) throw new Unreachable(`server speaks contract ${snap.contractVersion}, app speaks ${CONTRACT_VERSION}`);
        rev = snap.rev;
        hasSnapshot = true;
        store.set({ device: snap.device, projects: snap.projects, tasks: snap.tasks, requests: snap.requests, lastSyncedAt: Date.now() });
        persistNow();
      }
      openSocket();
    } catch (e) {
      teardown();
      if (isUnauthenticated(e)) {
        store.set({ connection: "unauthenticated" });
      } else {
        // Unreachable, an unexpected redirect or a non-JSON answer, or a server error: keep the cached state.
        if (!(e instanceof Unreachable) && !(e instanceof HttpError)) console.error("telepi sync failed", e);
        store.set({ connection: "unreachable" });
        running = false; // scheduleReconnect does not schedule while a boot is running
        scheduleReconnect();
      }
    } finally {
      running = false;
    }
  }

  // --- retry --------------------------------------------------------------

  function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleReconnect(): void {
    if (retryTimer || running) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    attempt++;
    const delay = base * (0.75 + Math.random() * 0.5);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  }

  function retryNow(): void {
    if (store.get().connection === "online" && ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt < STALE_AFTER_MS) return;
    teardown();
    clearRetry();
    void connect();
  }

  /** The page came back (foreground, network, bfcache): iOS may have killed the socket without telling us. */
  function wake(force: boolean): void {
    if (running) return;
    if (!force && store.get().connection === "online") {
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt < STALE_AFTER_MS) return;
    }
    teardown();
    clearRetry();
    void connect();
  }

  window.addEventListener("online", () => wake(true));
  window.addEventListener("pageshow", () => wake(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake(false);
  });

  return {
    connect: () => void connect(),
    retryNow,
    markUnreachable() {
      if (store.get().connection === "unauthenticated") return;
      teardown();
      store.set({ connection: "unreachable" });
      scheduleReconnect();
    },
    reset() {
      hasSnapshot = false;
    },
  };
}
