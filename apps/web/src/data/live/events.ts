// Per-task event logs: cache first, then a catch-up fetch, then live through task_event ops.
// Also holds optimistic user messages until the server's event (matching clientId) arrives.
import { TaskEvent, TaskEventsResponse, routes } from "@telepi/contract";
import type { TaskEventsHandle } from "../api";
import type { Cache } from "./cache";
import { MAX_EVENTS_PER_TASK } from "./cache";
import { call } from "./http";

interface Optimistic {
  clientId: string;
  text: string;
  at: number;
}

interface Entry {
  taskId: string;
  /** Confirmed events, unique by seq, sorted. Replaced, never mutated. */
  events: TaskEvent[];
  optimistic: Optimistic[];
  /** What getEvents() returns: events plus unconfirmed optimistic messages. */
  merged: TaskEvent[];
  listeners: Set<() => void>;
  handle: TaskEventsHandle;
  cacheRead: boolean;
  loading: boolean;
}

export interface Events {
  handle(taskId: string): TaskEventsHandle;
  /** Apply an event from the op stream. */
  ingest(event: TaskEvent): void;
  addOptimistic(taskId: string, clientId: string, text: string): void;
  removeOptimistic(taskId: string, clientId: string): void;
  /** Catch up every task someone is currently looking at. Call after (re)connecting. */
  refreshAll(): void;
  reset(): void;
}

const PAGE_LIMIT = 20;

export function createEvents(cache: Cache): Events {
  const entries = new Map<string, Entry>();
  const pendingUnloaded = new Map<string, TaskEvent[]>();
  const dirtyEmit = new Set<Entry>();
  let emitScheduled = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistIds = new Set<string>();

  function merge(entry: Entry): TaskEvent[] {
    if (entry.optimistic.length === 0) return entry.events;
    const last = entry.events[entry.events.length - 1]?.seq ?? 0;
    const extra: TaskEvent[] = entry.optimistic.map((o, i) => ({
      type: "user_message",
      taskId: entry.taskId,
      // Fractional so it can never collide with a real seq; position in the array is what orders it.
      seq: last + 0.5 + i * 0.001,
      at: o.at,
      text: o.text,
      clientId: o.clientId,
    }));
    return [...entry.events, ...extra];
  }

  function emit(entry: Entry): void {
    entry.merged = merge(entry);
    dirtyEmit.add(entry);
    if (emitScheduled) return;
    emitScheduled = true;
    queueMicrotask(() => {
      emitScheduled = false;
      const batch = [...dirtyEmit];
      dirtyEmit.clear();
      for (const e of batch) for (const l of [...e.listeners]) l();
    });
  }

  function schedulePersist(taskId: string): void {
    persistIds.add(taskId);
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const ids = [...persistIds];
      persistIds.clear();
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry?.cacheRead) {
          void cache.putEvents(id, entry.events);
        } else {
          const pending = pendingUnloaded.get(id);
          pendingUnloaded.delete(id);
          if (pending) void cache.appendEvents(id, pending);
        }
      }
    }, 300);
  }

  /** Add confirmed events; drops duplicates and matched optimistic copies. Returns whether anything changed. */
  function addConfirmed(entry: Entry, incoming: TaskEvent[]): boolean {
    const seen = new Set(entry.events.map((e) => e.seq));
    const fresh = incoming.filter((e) => !seen.has(e.seq));
    let changed = false;
    if (fresh.length > 0) {
      const last = entry.events[entry.events.length - 1]?.seq ?? -Infinity;
      const merged = [...entry.events, ...fresh];
      if (fresh.some((e) => e.seq < last) || fresh.length > 1) merged.sort((a, b) => a.seq - b.seq);
      entry.events = merged.length > MAX_EVENTS_PER_TASK * 2 ? merged.slice(-MAX_EVENTS_PER_TASK * 2) : merged;
      changed = true;
    }
    if (entry.optimistic.length > 0) {
      const confirmed = new Set<string>();
      for (const e of incoming) if (e.type === "user_message" && e.clientId) confirmed.add(e.clientId);
      if (confirmed.size > 0) {
        const left = entry.optimistic.filter((o) => !confirmed.has(o.clientId));
        if (left.length !== entry.optimistic.length) {
          entry.optimistic = left;
          changed = true;
        }
      }
    }
    return changed;
  }

  async function fetchAfterLast(entry: Entry): Promise<void> {
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const after = entry.events[entry.events.length - 1]?.seq ?? 0;
      const res = await call("GET", `${routes.taskEvents(entry.taskId)}?after=${after}`, { schema: TaskEventsResponse });
      if (res.events.length === 0) return;
      const before = entry.events.length;
      if (addConfirmed(entry, res.events)) {
        emit(entry);
        schedulePersist(entry.taskId);
      }
      if (entry.events.length === before) return; // server returned nothing new: stop
    }
  }

  async function load(entry: Entry): Promise<void> {
    if (entry.loading) return;
    entry.loading = true;
    try {
      if (!entry.cacheRead) {
        const cached = await cache.loadEvents(entry.taskId);
        entry.cacheRead = true;
        // Live ops may have arrived while the cache was being read.
        const live = entry.events;
        entry.events = [];
        addConfirmed(entry, cached);
        addConfirmed(entry, live);
        emit(entry);
        void cache.touchEvents(entry.taskId);
        const pending = pendingUnloaded.get(entry.taskId);
        if (pending) {
          pendingUnloaded.delete(entry.taskId);
          if (addConfirmed(entry, pending)) emit(entry);
        }
      }
      await fetchAfterLast(entry);
    } catch {
      // Offline or invalid: what we have stays on screen; refreshAll retries after reconnecting.
    } finally {
      entry.loading = false;
    }
  }

  function entryFor(taskId: string): Entry {
    let entry = entries.get(taskId);
    if (entry) return entry;
    const created: Entry = {
      taskId,
      events: [],
      optimistic: [],
      merged: [],
      listeners: new Set(),
      cacheRead: false,
      loading: false,
      handle: {
        getEvents: () => created.merged,
        subscribe(listener) {
          created.listeners.add(listener);
          if (created.listeners.size === 1) void load(created);
          return () => void created.listeners.delete(listener);
        },
      },
    };
    entries.set(taskId, created);
    entry = created;
    return entry;
  }

  return {
    handle: (taskId) => entryFor(taskId).handle,
    ingest(event) {
      const entry = entries.get(event.taskId);
      if (entry?.cacheRead) {
        if (addConfirmed(entry, [event])) {
          emit(entry);
          schedulePersist(event.taskId);
        }
        return;
      }
      if (entry && addConfirmed(entry, [event])) emit(entry);
      // Not loaded from the cache yet: remember it for the cache record (if one exists) and for the load.
      const list = pendingUnloaded.get(event.taskId) ?? [];
      list.push(event);
      pendingUnloaded.set(event.taskId, list);
      schedulePersist(event.taskId);
    },
    addOptimistic(taskId, clientId, text) {
      const entry = entryFor(taskId);
      if (entry.optimistic.some((o) => o.clientId === clientId)) return;
      entry.optimistic = [...entry.optimistic, { clientId, text, at: Date.now() }];
      emit(entry);
    },
    removeOptimistic(taskId, clientId) {
      const entry = entries.get(taskId);
      if (!entry) return;
      const left = entry.optimistic.filter((o) => o.clientId !== clientId);
      if (left.length === entry.optimistic.length) return;
      entry.optimistic = left;
      emit(entry);
    },
    refreshAll() {
      for (const entry of entries.values()) if (entry.listeners.size > 0) void load(entry);
    },
    reset() {
      pendingUnloaded.clear();
      for (const entry of entries.values()) {
        entry.events = [];
        entry.cacheRead = false;
        emit(entry);
      }
    },
  };
}
