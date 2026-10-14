// A repeated requestId from the same device returns the first response without redoing the work.
import type { State } from "./state";

export interface Reply {
  status: number;
  body: unknown;
}

/** Only successful results are remembered; a failed command can be retried after the client fixes it. */
export function idempotent(state: State, deviceId: string, requestId: string, run: () => Reply): Reply {
  const key = `${deviceId}:${requestId}`;
  const seen = state.idempotency.get(key);
  if (seen) return { status: seen.status, body: seen.body };
  const reply = run();
  state.idempotency.set(key, { at: Date.now(), ...reply });
  state.saveIdempotency();
  return reply;
}

/** The same, for a command that has to wait for something. */
export async function idempotentAsync(state: State, deviceId: string, requestId: string, run: () => Promise<Reply>): Promise<Reply> {
  const key = `${deviceId}:${requestId}`;
  const seen = state.idempotency.get(key);
  if (seen) return { status: seen.status, body: seen.body };
  const reply = await run();
  state.idempotency.set(key, { at: Date.now(), ...reply });
  state.saveIdempotency();
  return reply;
}
