// The observable AppState. getState() keeps its reference until a field really changes;
// listeners are notified once per burst of changes.
import type { AppState } from "../api";

export interface Store {
  get(): AppState;
  set(patch: Partial<AppState>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  let scheduled = false;

  function notify(): void {
    scheduled = false;
    for (const l of [...listeners]) l();
  }

  return {
    get: () => state,
    set(patch) {
      let changed = false;
      for (const key of Object.keys(patch) as (keyof AppState)[]) {
        if (!Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(notify);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Replace the item with the same id, or append it. */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}
