// Commands and the outbox. createTask and sendMessage queue when not online; answerRequest and stopTask never do.
import { AnswerRequestResponse, CreateTaskResponse, ModelsResponse, TaskDiff, routes, type ModelRef, type RequestAnswer } from "@telepi/contract";
import type { OutboxItem, RejectedItem, Result } from "../api";
import type { Cache } from "./cache";
import type { Events } from "./events";
import { HttpError, Unreachable, call, isUnauthenticated } from "./http";
import { upsertById, type Store } from "./store";
import type { Sync } from "./sync";

interface Deps {
  store: Store;
  cache: Cache;
  events: Events;
  sync: Sync;
}

export interface Commands {
  createTask(projectId: string, instruction: string): Promise<Result<{ taskId: string | null; queued: boolean }>>;
  sendMessage(taskId: string, text: string): Promise<Result<{ queued: boolean }>>;
  stopTask(taskId: string): Promise<Result>;
  answerRequest(requestId: string, answer: RequestAnswer): Promise<Result>;
  dismissRejected(id: string): void;
  getDiff(taskId: string, path: string, opts?: { full?: boolean }): Promise<Result<TaskDiff>>;
  getModels(): Promise<Result<ModelsResponse>>;
  setModel(model: ModelRef | null): Promise<Result<ModelsResponse>>;
  flushOutbox(): Promise<void>;
}

/** 4xx means the server looked at the command and said no; retrying the same thing is pointless. */
function isRejection(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  return e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429;
}

export function createCommands({ store, cache, events, sync }: Deps): Commands {
  // Outbox order is createdAt order; two sends in the same millisecond must not tie.
  let lastStamp = 0;
  const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));
  const online = () => store.get().connection === "online";

  function failure(e: unknown): { ok: false; error: string; message: string } {
    if (e instanceof Unreachable) {
      sync.markUnreachable();
      return { ok: false, error: "offline", message: "The home machine cannot be reached." };
    }
    if (e instanceof HttpError) {
      if (isUnauthenticated(e)) store.set({ connection: "unauthenticated" });
      return { ok: false, error: e.code, message: e.message };
    }
    return { ok: false, error: "internal", message: e instanceof Error ? e.message : "Unexpected error" };
  }

  function enqueue(item: OutboxItem): void {
    store.set({ outbox: [...store.get().outbox, item] });
    void cache.putOutbox(item);
  }

  function dequeue(id: string): void {
    store.set({ outbox: store.get().outbox.filter((i) => i.id !== id) });
    void cache.deleteOutbox(id);
  }

  async function post(item: OutboxItem): Promise<void> {
    if (item.kind === "task") {
      const res = await call("POST", routes.tasks, {
        body: { requestId: item.id, projectId: item.projectId, instruction: item.text },
        schema: CreateTaskResponse,
      });
      store.set({ tasks: upsertById(store.get().tasks, res.task) });
    } else {
      await call("POST", routes.taskMessages(item.taskId ?? ""), { body: { requestId: item.id, text: item.text } });
    }
  }

  let flushing = false;
  async function flushOutbox(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      for (const item of [...store.get().outbox]) {
        if (!online()) break;
        try {
          await post(item);
          dequeue(item.id);
        } catch (e) {
          if (isRejection(e)) {
            dequeue(item.id);
            const rejected: RejectedItem = { item, message: (e as HttpError).message, rejectedAt: Date.now() };
            store.set({ rejected: [...store.get().rejected, rejected] });
            void cache.putRejected(rejected);
            if (item.taskId) events.removeOptimistic(item.taskId, item.id);
            continue;
          }
          failure(e); // marks unreachable / unauthenticated; the item stays for the next flush
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    flushOutbox,

    async createTask(projectId, instruction) {
      const item: OutboxItem = { id: crypto.randomUUID(), kind: "task", projectId, taskId: null, text: instruction, createdAt: stamp() };
      if (online()) {
        try {
          const res = await call("POST", routes.tasks, {
            body: { requestId: item.id, projectId, instruction },
            schema: CreateTaskResponse,
          });
          store.set({ tasks: upsertById(store.get().tasks, res.task) });
          return { ok: true, value: { taskId: res.task.id, queued: false } };
        } catch (e) {
          if (!(e instanceof Unreachable)) return failure(e);
          sync.markUnreachable(); // fall through: queue it. The same requestId makes the retry safe.
        }
      }
      enqueue(item);
      return { ok: true, value: { taskId: null, queued: true } };
    },

    async sendMessage(taskId, text) {
      const projectId = store.get().tasks.find((t) => t.id === taskId)?.projectId ?? "";
      const item: OutboxItem = { id: crypto.randomUUID(), kind: "message", projectId, taskId, text, createdAt: stamp() };
      events.addOptimistic(taskId, item.id, text);
      if (online()) {
        try {
          await call("POST", routes.taskMessages(taskId), { body: { requestId: item.id, text } });
          return { ok: true, value: { queued: false } };
        } catch (e) {
          if (!(e instanceof Unreachable)) {
            events.removeOptimistic(taskId, item.id);
            return failure(e);
          }
          sync.markUnreachable();
        }
      }
      enqueue(item);
      return { ok: true, value: { queued: true } };
    },

    async stopTask(taskId) {
      if (!online()) return { ok: false, error: "offline", message: "Stopping a task needs a live connection." };
      try {
        await call("POST", routes.taskStop(taskId), { body: { requestId: crypto.randomUUID() } });
        return { ok: true, value: undefined };
      } catch (e) {
        return failure(e);
      }
    },

    dismissRejected(id) {
      store.set({ rejected: store.get().rejected.filter((r) => r.item.id !== id) });
      void cache.deleteRejected(id);
    },

    // Never cached: not in IndexedDB, not in memory beyond the caller.
    async getDiff(taskId, path, opts) {
      if (!online()) return { ok: false, error: "offline", message: "Diffs need a live connection." };
      try {
        const query = `path=${encodeURIComponent(path)}${opts?.full ? "&full=1" : ""}`;
        const value = await call("GET", `${routes.taskDiff(taskId)}?${query}`, { schema: TaskDiff });
        return { ok: true, value };
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return { ok: false, error: "not_found", message: e.message };
        return failure(e);
      }
    },

    async getModels() {
      if (!online()) return { ok: false, error: "offline", message: "Models need a live connection." };
      try {
        return { ok: true, value: await call("GET", routes.models, { schema: ModelsResponse }) };
      } catch (e) {
        return failure(e);
      }
    },

    async setModel(model) {
      if (!online()) return { ok: false, error: "offline", message: "Changing the model needs a live connection." };
      try {
        const value = await call("POST", routes.models, { body: { requestId: crypto.randomUUID(), model }, schema: ModelsResponse });
        return { ok: true, value };
      } catch (e) {
        return failure(e);
      }
    },

    async answerRequest(requestId, answer) {
      if (!online()) return { ok: false, error: "offline", message: "Answering needs a live connection." };
      try {
        const res = await call("POST", routes.requestAnswer(requestId), {
          body: { requestId: crypto.randomUUID(), answer },
          schema: AnswerRequestResponse,
        });
        store.set({ requests: upsertById(store.get().requests, res.request) });
        return { ok: true, value: undefined };
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) {
          return { ok: false, error: "request_closed", message: e.message };
        }
        return failure(e);
      }
    },
  };
}
