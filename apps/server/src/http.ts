// Errors that map to the contract's ApiError, and body validation.
import type { ApiError, ErrorCode } from "@telepi/contract";
import type { z } from "zod";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  bad_pairing_code: 401,
  rate_limited: 429,
  invalid: 400,
  not_found: 404,
  request_closed: 409,
  internal: 500,
};

export class HttpError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
  toBody(): ApiError {
    return { error: this.code, message: this.message };
  }
}

export function parseBody<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new HttpError("invalid", `${where}${issue?.message ?? "invalid body"}`);
  }
  return result.data;
}
