// Pi's own files, read and written the way Pi does: the credentials (auth.json) and the model catalogs
// (models-store.json) as pi-ai stores, and the default model (settings.json). The user may run `pi` and /login at any
// moment, so nothing is cached: every read goes to the file, and every write takes the same lock Pi takes.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

/** Pi's home directory: TELEPI_PI_DIR, else where Pi keeps it. */
export function piDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.TELEPI_PI_DIR ? path.resolve(env.TELEPI_PI_DIR) : path.join(os.homedir(), ".pi", "agent");
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file} is not a JSON object.`);
  return value as Record<string, unknown>;
}

/** Write to a temporary file and rename it over the target, so a reader never sees half a file. */
async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** Reads, changes and writes one JSON file under the lock Pi uses for it (proper-lockfile on the file itself). */
async function modifyLocked<T>(file: string, change: (data: Record<string, unknown>) => Promise<{ data: Record<string, unknown>; result: T } | { result: T }>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{}", { mode: 0o600, flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const release = await lockfile.lock(file, { retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true }, stale: 30_000 });
  try {
    const out = await change(await readJson(file));
    if ("data" in out) await writeAtomic(file, out.data);
    return out.result;
  } finally {
    await release().catch(() => {});
  }
}

/** auth.json: `{ "<providerId>": { type: "api_key", key } | { type: "oauth", ... } }`. */
export class FileCredentialStore implements CredentialStore {
  constructor(private file: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await readJson(this.file))[providerId] as Credential | undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await readJson(this.file)).map(([providerId, c]) => ({ providerId, type: (c as Credential).type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return modifyLocked(this.file, async (data) => {
      const current = data[providerId] as Credential | undefined;
      const next = await fn(current);
      return next === undefined ? { result: current } : { data: { ...data, [providerId]: next }, result: next };
    });
  }

  async delete(providerId: string): Promise<void> {
    await modifyLocked(this.file, async (data) => {
      const { [providerId]: _gone, ...rest } = data;
      return { data: rest, result: undefined };
    });
  }
}

/** models-store.json: `{ "<providerId>": { models, checkedAt, ... } }`. */
export class FileModelsStore implements ModelsStore {
  constructor(private file: string) {}

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return (await readJson(this.file))[providerId] as ModelsStoreEntry | undefined;
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await modifyLocked(this.file, async (data) => ({ data: { ...data, [providerId]: entry }, result: undefined }));
  }

  async delete(providerId: string): Promise<void> {
    await modifyLocked(this.file, async (data) => {
      const { [providerId]: _gone, ...rest } = data;
      return { data: rest, result: undefined };
    });
  }
}

export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
}

/** settings.json, read fresh. A missing or unreadable file means no defaults. */
export async function readPiSettings(piDir: string): Promise<PiSettings> {
  try {
    const data = await readJson(path.join(piDir, "settings.json"));
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { defaultProvider: str(data.defaultProvider), defaultModel: str(data.defaultModel), defaultThinkingLevel: str(data.defaultThinkingLevel) };
  } catch (error) {
    console.warn("telepi: could not read Pi's settings.json:", error instanceof Error ? error.message : error);
    return {};
  }
}
