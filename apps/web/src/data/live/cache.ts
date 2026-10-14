// IndexedDB cache: last known state, the outbox, and a bounded set of task events.
// Every method swallows storage errors: the app must work without a cache.
import { openDB, type IDBPDatabase } from "idb";
import { CONTRACT_VERSION, Project, Request, Task, TaskEvent, Device } from "@telepi/contract";
import { z } from "zod";
import type { OutboxItem, RejectedItem } from "../api";

export const MAX_EVENTS_PER_TASK = 500;
export const MAX_CACHED_TASKS = 30;

export interface Meta {
  contractVersion: number;
  rev: number;
  lastSyncedAt: number | null;
  device: Device | null;
  projects: Project[];
  tasks: Task[];
  requests: Request[];
}

const MetaSchema = z.object({
  contractVersion: z.number(),
  rev: z.number(),
  lastSyncedAt: z.number().nullable(),
  device: Device.nullable(),
  projects: z.array(Project),
  tasks: z.array(Task),
  requests: z.array(Request),
});

interface EventsRecord {
  taskId: string;
  events: TaskEvent[];
  touchedAt: number;
}

export interface Cache {
  /** Cached state, or null when empty, invalid or from another contract version (then the cache is dropped). */
  loadMeta(): Promise<Meta | null>;
  saveMeta(meta: Meta): Promise<void>;
  loadOutbox(): Promise<OutboxItem[]>;
  putOutbox(item: OutboxItem): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
  loadRejected(): Promise<RejectedItem[]>;
  putRejected(item: RejectedItem): Promise<void>;
  deleteRejected(id: string): Promise<void>;
  loadEvents(taskId: string): Promise<TaskEvent[]>;
  /** Replace a task's cached events (last 500) and prune to the 30 most recently touched tasks. */
  putEvents(taskId: string, events: TaskEvent[]): Promise<void>;
  /** Add events to a task that already has a cached record; does nothing otherwise. */
  appendEvents(taskId: string, events: TaskEvent[]): Promise<void>;
  /** Mark a task as recently used so it survives pruning. */
  touchEvents(taskId: string): Promise<void>;
  /** Drops cached state and events. The outbox is user input, not cache, and stays. */
  clearAll(): Promise<void>;
}

export function createCache(): Cache {
  const dbPromise: Promise<IDBPDatabase | null> = openDB("telepi", 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
      if (!db.objectStoreNames.contains("events")) db.createObjectStore("events", { keyPath: "taskId" });
      // Queued items the server refused; user input like the outbox, so clearAll leaves it.
      if (!db.objectStoreNames.contains("rejected")) db.createObjectStore("rejected", { keyPath: "item.id" });
    },
  }).catch(() => null);

  async function guard<T>(fallback: T, fn: (db: IDBPDatabase) => Promise<T>): Promise<T> {
    try {
      const db = await dbPromise;
      return db ? await fn(db) : fallback;
    } catch {
      return fallback;
    }
  }

  async function prune(db: IDBPDatabase): Promise<void> {
    const all = (await db.getAll("events")) as EventsRecord[];
    if (all.length <= MAX_CACHED_TASKS) return;
    all.sort((a, b) => b.touchedAt - a.touchedAt);
    const tx = db.transaction("events", "readwrite");
    for (const r of all.slice(MAX_CACHED_TASKS)) void tx.store.delete(r.taskId);
    await tx.done;
  }

  const cache: Cache = {
    loadMeta: () =>
      guard<Meta | null>(null, async (db) => {
        const raw = await db.get("meta", "state");
        if (raw === undefined) return null;
        const parsed = MetaSchema.safeParse(raw);
        if (!parsed.success || parsed.data.contractVersion !== CONTRACT_VERSION) {
          await cache.clearAll();
          return null;
        }
        return parsed.data;
      }),
    saveMeta: (meta) => guard(undefined, async (db) => void (await db.put("meta", meta, "state"))),
    loadOutbox: () =>
      guard<OutboxItem[]>([], async (db) => {
        const items = (await db.getAll("outbox")) as OutboxItem[];
        return items.sort((a, b) => a.createdAt - b.createdAt);
      }),
    putOutbox: (item) => guard(undefined, async (db) => void (await db.put("outbox", item))),
    deleteOutbox: (id) => guard(undefined, async (db) => void (await db.delete("outbox", id))),
    loadRejected: () =>
      guard<RejectedItem[]>([], async (db) => {
        const items = (await db.getAll("rejected")) as RejectedItem[];
        return items.sort((a, b) => a.rejectedAt - b.rejectedAt);
      }),
    putRejected: (item) => guard(undefined, async (db) => void (await db.put("rejected", item))),
    deleteRejected: (id) => guard(undefined, async (db) => void (await db.delete("rejected", id))),
    loadEvents: (taskId) =>
      guard<TaskEvent[]>([], async (db) => {
        const rec = (await db.get("events", taskId)) as EventsRecord | undefined;
        if (!rec) return [];
        const parsed = z.array(TaskEvent).safeParse(rec.events);
        return parsed.success ? parsed.data : [];
      }),
    putEvents: (taskId, events) =>
      guard(undefined, async (db) => {
        const rec: EventsRecord = { taskId, events: events.slice(-MAX_EVENTS_PER_TASK), touchedAt: Date.now() };
        await db.put("events", rec);
        await prune(db);
      }),
    appendEvents: (taskId, events) =>
      guard(undefined, async (db) => {
        const tx = db.transaction("events", "readwrite");
        const rec = (await tx.store.get(taskId)) as EventsRecord | undefined;
        if (rec) {
          const seen = new Set(rec.events.map((e) => e.seq));
          const merged = [...rec.events, ...events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
          await tx.store.put({ taskId, events: merged.slice(-MAX_EVENTS_PER_TASK), touchedAt: Date.now() });
        }
        await tx.done;
      }),
    touchEvents: (taskId) =>
      guard(undefined, async (db) => {
        const tx = db.transaction("events", "readwrite");
        const rec = (await tx.store.get(taskId)) as EventsRecord | undefined;
        if (rec) await tx.store.put({ ...rec, touchedAt: Date.now() });
        await tx.done;
      }),
    clearAll: () =>
      guard(undefined, async (db) => {
        for (const name of ["meta", "events"] as const) await db.clear(name);
      }),
  };
  return cache;
}
