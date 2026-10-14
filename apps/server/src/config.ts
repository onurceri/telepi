// Environment configuration. Read once at start.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { piDirOf } from "./runtime/pi/pihome";

export interface Config {
  port: number;
  host: "127.0.0.1";
  dataDir: string;
  /** Origin the app is reached at, e.g. "https://telepi.tailnet.ts.net". No path, no trailing slash. */
  publicOrigin: string | null;
  /** True when the public origin is https: the session cookie is then Secure. */
  secureCookies: boolean;
  /** Print a fresh pairing code at start even if devices exist. */
  forcePair: boolean;
  /** Built app to serve, if it exists. */
  webDist: string;
  /** Which agent runtime runs tasks: the scripted fake, or the real agent on Pi Durable in an OpenShell sandbox. */
  runtime: "fake" | "pi";
  /** Pi's home directory: its login (auth.json), model catalogs and settings. */
  piDir: string;
  /** TELEPI_MODEL, "provider/modelId": the model for new tasks unless one was chosen in telepi. */
  model: string | undefined;
  /** Model turns allowed per run of the pi runtime. */
  maxTurns: number | undefined;
  /** Address of the OpenShell gateway's gRPC port. */
  openshellGateway: string;
  /** PEM files for the mutually authenticated connection to the gateway, when it has TLS on. */
  openshellTls: { ca: string; cert: string; key: string; serverName?: string } | undefined;
  /** Root directory of the task workspaces. */
  workspacesDir: string;
  /** Root of local project remotes the OpenShell gateway can see, if declared. */
  remotesDir: string | undefined;
  /** Ask before shell commands that match the pattern list (packages/decision). Off by default: the sandbox is the boundary. */
  askPatterns: boolean;
  /** GitHub: the token (held by an OpenShell provider, never in a sandbox) and where its API and git host are. Null without a token. */
  github: { token: string; apiUrl: string; gitUrl: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.TELEPI_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid TELEPI_PORT: ${env.TELEPI_PORT}`);

  let publicOrigin: string | null = null;
  if (env.TELEPI_PUBLIC_URL) {
    try {
      publicOrigin = new URL(env.TELEPI_PUBLIC_URL).origin;
    } catch {
      throw new Error(`Invalid TELEPI_PUBLIC_URL: ${env.TELEPI_PUBLIC_URL}`);
    }
  }

  const runtime = env.TELEPI_RUNTIME ?? "fake";
  if (runtime !== "fake" && runtime !== "pi") throw new Error(`Invalid TELEPI_RUNTIME: ${runtime} (use "fake" or "pi")`);

  const tlsVars = [env.OPENSHELL_TLS_CA, env.OPENSHELL_TLS_CERT, env.OPENSHELL_TLS_KEY];
  if (tlsVars.some(Boolean) && !tlsVars.every(Boolean)) throw new Error("Set all of OPENSHELL_TLS_CA, OPENSHELL_TLS_CERT and OPENSHELL_TLS_KEY, or none.");
  const defaultData = fileURLToPath(new URL("../.data", import.meta.url));
  const dataDir = env.TELEPI_DATA_DIR ? path.resolve(env.TELEPI_DATA_DIR) : defaultData;
  return {
    port,
    host: "127.0.0.1",
    dataDir,
    publicOrigin,
    secureCookies: publicOrigin?.startsWith("https:") ?? false,
    forcePair: env.TELEPI_PAIR === "1",
    webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
    runtime,
    piDir: piDirOf(env),
    model: env.TELEPI_MODEL || undefined,
    maxTurns: env.TELEPI_MAX_TURNS ? Number(env.TELEPI_MAX_TURNS) : undefined,
    openshellGateway: env.OPENSHELL_GATEWAY || "127.0.0.1:8080",
    openshellTls: tlsVars.every(Boolean) ? { ca: path.resolve(tlsVars[0]!), cert: path.resolve(tlsVars[1]!), key: path.resolve(tlsVars[2]!), serverName: env.OPENSHELL_TLS_SERVER_NAME || undefined } : undefined,
    workspacesDir: env.TELEPI_WORKSPACES ? path.resolve(env.TELEPI_WORKSPACES) : path.join(dataDir, "workspaces"),
    remotesDir: env.TELEPI_REMOTES ? path.resolve(env.TELEPI_REMOTES) : undefined,
    askPatterns: env.TELEPI_ASK_PATTERNS === "1",
    // TELEPI_GITHUB_API and TELEPI_GITHUB_GIT exist only so a test can point GitHub at another server.
    github: env.TELEPI_GITHUB_TOKEN
      ? { token: env.TELEPI_GITHUB_TOKEN, apiUrl: (env.TELEPI_GITHUB_API || "https://api.github.com").replace(/\/+$/, ""), gitUrl: (env.TELEPI_GITHUB_GIT || "https://github.com").replace(/\/+$/, "") }
      : null,
  };
}
