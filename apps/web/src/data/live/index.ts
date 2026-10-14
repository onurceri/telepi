// The live data layer: DataApi backed by the server, with an IndexedDB cache and an outbox.
import { PairBody, SessionResponse, routes } from "@telepi/contract";
import type { AppState, DataApi, Device, Result } from "../api";
import { createCache } from "./cache";
import { createCommands, type Commands } from "./commands";
import { createEvents } from "./events";
import { HttpError, Unreachable, call } from "./http";
import { installPageBridge, type PageBridge } from "./page-bridge";
import { currentPushState, enablePush, refreshSubscription } from "./push";
import { createStore } from "./store";
import { createSync } from "./sync";

export function createLiveData(): DataApi {
  const store = createStore({
    connection: "connecting",
    lastSyncedAt: null,
    device: null,
    projects: [],
    tasks: [],
    requests: [],
    outbox: [],
    rejected: [],
    push: currentPushState(),
    updateReady: false,
  } satisfies AppState);
  const cache = createCache();
  const events = createEvents(cache);
  let commands!: Commands;
  let bridge: PageBridge | undefined;
  const sync = createSync({
    store,
    onStale: () => bridge?.requireUpdate(),
    cache,
    events,
    onOnline() {
      void commands.flushOutbox();
      events.refreshAll();
      void refreshSubscription();
    },
  });
  commands = createCommands({ store, cache, events, sync });

  // Draw from the cache straight away, then talk to the network.
  void (async () => {
    const [meta, outbox, rejected] = await Promise.all([cache.loadMeta(), cache.loadOutbox(), cache.loadRejected()]);
    if (rejected.length > 0) store.set({ rejected: [...rejected, ...store.get().rejected] });
    if (meta) {
      store.set({ lastSyncedAt: meta.lastSyncedAt, device: meta.device, projects: meta.projects, tasks: meta.tasks, requests: meta.requests });
    }
    if (outbox.length > 0) {
      store.set({ outbox: [...outbox, ...store.get().outbox] });
      for (const item of outbox) if (item.kind === "message" && item.taskId) events.addOptimistic(item.taskId, item.id, item.text);
    }
    sync.connect();
  })();

  bridge = installPageBridge(store);

  return {
    getState: store.get,
    subscribe: store.subscribe,
    taskEvents: events.handle,

    async pair(code, deviceName): Promise<Result<Device>> {
      try {
        const body = PairBody.parse({ code, deviceName });
        const session = await call("POST", routes.pair, { body, schema: SessionResponse });
        store.set({ connection: "connecting", device: session.device });
        sync.reset();
        sync.connect();
        return { ok: true, value: session.device };
      } catch (e) {
        if (e instanceof HttpError) return { ok: false, error: e.code, message: e.message };
        if (e instanceof Unreachable) return { ok: false, error: "offline", message: "The home machine cannot be reached." };
        return { ok: false, error: "invalid", message: e instanceof Error ? e.message : "Invalid pairing details." };
      }
    },

    createTask: commands.createTask,
    sendMessage: commands.sendMessage,
    stopTask: commands.stopTask,
    answerRequest: commands.answerRequest,
    dismissRejected: commands.dismissRejected,
    getDiff: commands.getDiff,
    getModels: commands.getModels,
    setModel: commands.setModel,

    async enablePush() {
      const result = await enablePush();
      store.set({ push: currentPushState() });
      return result;
    },

    retryNow: sync.retryNow,
    applyUpdate: () => bridge?.applyUpdate(),
  };
}
