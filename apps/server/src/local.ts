// Endpoints for the telepi CLI on the same machine: a fresh pairing code, and adding a project to a running server.
// Not for phones. A request is accepted only when ALL of these hold:
//   - it comes from a loopback address,
//   - it carries no Origin header (a browser always sends one on a cross-site request; the CLI never does),
//   - it presents the per-install secret in the x-telepi-local header.
// The secret is what really matters: a reverse proxy such as `tailscale serve` or cloudflared also connects from
// loopback, so the remote address alone says nothing about who is on the other end. The secret is a random token
// written to <data dir>/local-token (mode 0600) at every start; only a process that can read that file has it.
// Everything else gets the same 404 as an unknown route.
import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ModelsResponse, Project } from "@telepi/contract";
import type { Auth } from "./auth";
import type { Config } from "./config";
import { HttpError, parseBody } from "./http";
import type { State } from "./state";

export const LOCAL_TOKEN_FILE = "local-token";
export const LOCAL_TOKEN_HEADER = "x-telepi-local";
export const LOCAL_PREFIX = "/api/local/";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Makes a new secret and writes it where only this user can read it. */
export function writeLocalToken(dataDir: string): string {
  const token = randomBytes(32).toString("base64url");
  const file = path.join(dataDir, LOCAL_TOKEN_FILE);
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600); // the mode above does not apply when the file already existed
  return token;
}

/** Throws a plain not_found unless the request passes all three checks above. */
export function checkLocal(req: Pick<FastifyRequest, "headers"> & { socket: { remoteAddress?: string } }, token: string): void {
  const given = req.headers[LOCAL_TOKEN_HEADER];
  const a = Buffer.from(typeof given === "string" ? given : "");
  const b = Buffer.from(token);
  const ok = LOOPBACK.has(req.socket.remoteAddress ?? "") && req.headers.origin === undefined && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) throw new HttpError("not_found", "Not found.");
}

const git = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim();

const AddProjectBody = z.object({ repoPath: z.string().min(1) });

/** The same checks the CLI makes: a git repository with an origin, which a local origin inside the remotes folder. */
function validateRepo(input: string, remotesDir: string | undefined): { repo: string; name: string; id: string } {
  if (!path.isAbsolute(input)) throw new HttpError("invalid", "repoPath must be an absolute path.");
  let repo: string;
  try {
    repo = fs.realpathSync(git(input, "rev-parse", "--show-toplevel"));
  } catch {
    throw new HttpError("invalid", `${input} is not a git repository.`);
  }
  let origin: string;
  try {
    origin = git(repo, "remote", "get-url", "origin");
  } catch {
    throw new HttpError("invalid", `${repo} has no "origin" remote. telepi pushes work back to origin.`);
  }
  if (!/^([a-z+]+:\/\/|[^/@]+@[^/]+:)/i.test(origin)) {
    let abs: string | null = null;
    try {
      abs = fs.realpathSync(path.resolve(repo, origin));
    } catch {}
    const root = remotesDir && fs.existsSync(remotesDir) ? fs.realpathSync(remotesDir) : null;
    if (!abs || !root || (abs !== root && !abs.startsWith(root + path.sep))) {
      throw new HttpError("invalid", `origin is a local folder outside ${root ?? "TELEPI_REMOTES (not set)"}, which is the only place the sandbox gateway can see. Use a hosted origin or move it there.`);
    }
  }
  const name = path.basename(repo);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  return { repo, name, id };
}

export function registerLocal(app: FastifyInstance, deps: { config: Config; state: State; auth: Auth; commands: { models(): Promise<ModelsResponse> } }, token: string): void {
  const { config, state, auth, commands } = deps;
  const guard = async (req: FastifyRequest) => checkLocal(req, token);

  // What setup and doctor report about the model new tasks will run on.
  app.post(`${LOCAL_PREFIX}models`, { onRequest: guard }, async (): Promise<ModelsResponse> => commands.models());

  app.post(`${LOCAL_PREFIX}pairing-code`, { onRequest: guard }, async () => ({ code: auth.newPairingCode() }));

  // Adds a project, or replaces the one with the same id (its status and allowed actions stay). Phones get it as a
  // project_upsert op on the normal stream, like any other project change.
  app.post(`${LOCAL_PREFIX}projects`, { onRequest: guard }, async (req): Promise<{ project: Project }> => {
    const { repoPath } = parseBody(AddProjectBody, req.body);
    const { repo, name, id } = validateRepo(repoPath, config.remotesDir);
    const old = state.projects.get(id);
    state.repoPaths.set(id, repo);
    const project: Project = { status: "idle", allowedActions: [], ...old, id, name };
    state.putProject(project);
    return { project };
  });
}
