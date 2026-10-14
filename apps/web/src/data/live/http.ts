// Thin fetch wrapper. Its main job is to tell the two failure kinds apart:
// an ApiError from the server (HttpError) versus "cannot talk to the server" (Unreachable).
import { ApiError } from "@telepi/contract";
import type { z } from "zod";

/** The server could not be reached, or something other than the server answered. */
export class Unreachable extends Error {}

/** The server answered with an ApiError. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isUnauthenticated(e: unknown): boolean {
  return e instanceof HttpError && e.status === 401 && e.code === "unauthenticated";
}

const TIMEOUT_MS = 15_000;

interface CallOptions<T> {
  body?: unknown;
  /** Validates the response body. Without it the body is ignored (and may be empty). */
  schema?: z.ZodType<T>;
}

export async function call<T = undefined>(method: "GET" | "POST" | "DELETE", path: string, options: CallOptions<T> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      // A redirect (for example to a login page of a proxy) is not an answer from the server.
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Unreachable(e instanceof Error ? e.message : "network error");
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new Unreachable("unexpected redirect");

  let json: unknown;
  try {
    const text = await res.text();
    if (text !== "") json = JSON.parse(text);
  } catch {
    throw new Unreachable(`non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    if (!parsed.success) throw new Unreachable(`unexpected response (HTTP ${res.status})`);
    throw new HttpError(res.status, parsed.data.error, parsed.data.message);
  }
  if (!options.schema) return undefined as T;
  const parsed = options.schema.safeParse(json);
  if (!parsed.success) throw new Unreachable(`response does not match the contract: ${parsed.error.message}`);
  return parsed.data;
}
