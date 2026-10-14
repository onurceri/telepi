// Reads a shell command: the script it runs and whether it reaches a git remote (for the pattern list), and the hosts it
// plainly goes to (for asking before it runs).
import type { ShellCall } from "@telepi/decision";

export const MAX_SCRIPT_BYTES = 20_000;

/** Splits a command line into simple commands, then words with quotes stripped. */
export function words(text: string): string[][] {
  return text
    .split(/&&|\|\||[;|&\n]/)
    .map((s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, "")))
    .filter((w) => w.length > 0);
}

/** Skips what only wraps a command: env assignments, sudo, env, timeout N, nice, nohup, time, command, exec. */
function head(segment: string[]): { cmd: string; args: string[] } | null {
  let i = 0;
  for (;;) {
    const w = segment[i] ?? "";
    const name = w.split("/").pop() ?? w;
    if (/^\w+=/.test(w) || ["sudo", "nohup", "time", "command", "exec", "nice", "env", "stdbuf"].includes(name)) {
      i++;
      while (["nice", "stdbuf", "env"].includes(name) && (segment[i] ?? "").startsWith("-")) i++;
    } else if (name === "timeout") {
      i++;
      while ((segment[i] ?? "").startsWith("-")) i += /^-[ks]$/.test(segment[i]!) ? 2 : 1; // flags, some with a value
      i++; // the duration
    } else break;
  }
  const cmd = segment[i];
  if (!cmd) return null;
  return { cmd: cmd.split("/").pop() ?? cmd, args: segment.slice(i + 1) };
}

const GIT_REMOTE = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);

/** True when the command talks to a git remote. */
export function reachesGitRemote(command: string): boolean {
  return words(command).some((seg) => {
    const h = head(seg);
    if (!h || h.cmd !== "git") return false;
    const sub = h.args.find((a) => !a.startsWith("-"));
    return sub !== undefined && GIT_REMOTE.has(sub);
  });
}

// --- Where a command plainly goes ----------------------------------------------------------------------------------

export interface Destination {
  host: string;
  port: number;
}

const DEFAULT_PORT: Record<string, number> = { "https:": 443, "http:": 80, "ssh:": 22, "git:": 9418 };
/** Words that look like a host but are file names. */
const FILE_EXTENSIONS = new Set(["txt", "json", "html", "htm", "md", "js", "mjs", "cjs", "ts", "sh", "py", "rb", "tar", "gz", "tgz", "zip", "log", "out", "csv", "yaml", "yml", "xml", "png", "jpg", "jpeg", "gif", "svg", "pdf", "sql", "toml", "lock", "css", "map", "bin", "dat", "tmp", "env"]);
/** Options that take a value, so the next word is not a URL. */
const CURL_VALUE_FLAGS = new Set(["-o", "-H", "-d", "-X", "-u", "-A", "-e", "-m", "-b", "-c", "-F", "-T", "-w", "-x", "-K", "-D", "-r", "-U", "-Q", "--output", "--header", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--request", "--user", "--user-agent", "--referer", "--max-time", "--cookie", "--cookie-jar", "--form", "--upload-file", "--write-out", "--proxy", "--config", "--retry", "--connect-timeout"]);
const WGET_VALUE_FLAGS = new Set(["-O", "-o", "-P", "-t", "-T", "-U", "-e", "-a", "-i", "--output-document", "--output-file", "--directory-prefix", "--header", "--post-data", "--post-file", "--tries", "--timeout", "--user-agent", "--referer", "--user", "--password"]);

/** A destination from something shaped like a URL, a host:port, or `user@host:path`; null when it is not one. */
function destinationOf(arg: string, fallbackScheme = "https:"): Destination | null {
  if (/[$`(){}\\]/.test(arg)) return null; // built at run time: the supervisor's denial will tell
  const scp = /^(?:[\w.-]+@)([\w.-]+):(?!\/\/)/.exec(arg);
  if (scp) return { host: scp[1]!.toLowerCase(), port: 22 };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? arg : /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(arg) ? `${fallbackScheme}//${arg}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    const host = u.hostname.toLowerCase();
    if (!host || host === "localhost" || host.startsWith("[") || /^127\./.test(host)) return null;
    const ext = host.split(".").pop() ?? "";
    if (!/^\d+$/.test(ext) && FILE_EXTENSIONS.has(ext) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return null;
    const port = u.port ? Number(u.port) : DEFAULT_PORT[u.protocol];
    return port ? { host, port } : null;
  } catch {
    return null;
  }
}

/**
 * The hosts a shell command plainly reaches, for asking the user before it runs: curl and wget URLs, the remote of
 * git clone/fetch/pull/push/ls-remote, the registry for npm/pnpm/yarn installs, PyPI for pip. A command that reaches
 * a host through a script or a variable is not seen here; the supervisor's denial catches it afterwards.
 */
export function networkDestinations(command: string, originUrl?: string): Destination[] {
  const found: Destination[] = [];
  const add = (d: Destination | null) => d && found.push(d);
  for (const seg of words(command)) {
    const h = head(seg);
    if (!h) continue;
    const args = h.args;
    if (h.cmd === "curl" || h.cmd === "wget" || h.cmd === "http" || h.cmd === "https") {
      const scheme = h.cmd === "curl" || h.cmd === "wget" ? "http:" : "https:";
      const valueFlags = h.cmd === "wget" ? WGET_VALUE_FLAGS : CURL_VALUE_FLAGS;
      args.forEach((a, i) => {
        if (a.startsWith("-") && !a.includes("://")) return;
        if (valueFlags.has(args[i - 1] ?? "")) return;
        add(destinationOf(a.replace(/^--?\w[\w-]*=/, ""), scheme));
      });
    } else if (h.cmd === "git") {
      const sub = h.args.find((a) => !a.startsWith("-"));
      if (!sub || !GIT_REMOTE.has(sub)) continue;
      const operands = h.args.slice(h.args.indexOf(sub) + 1).filter((a) => !a.startsWith("-"));
      const urls = operands.map((a) => (/^[a-z][a-z0-9+.-]*:\/\/|^[\w.-]+@[\w.-]+:/i.test(a) ? destinationOf(a) : null)).filter((d): d is Destination => d !== null);
      if (urls.length > 0) urls.forEach(add);
      else if (originUrl && /^[a-z][a-z0-9+.-]*:\/\/|^[\w.-]+@[\w.-]+:/i.test(originUrl)) add(destinationOf(originUrl)); // no URL given: the clone's origin
    } else if (["npm", "pnpm", "yarn", "npx", "bunx"].includes(h.cmd)) {
      const sub = h.args.find((a) => !a.startsWith("-"));
      const installs = h.cmd === "npx" || h.cmd === "bunx" || (sub !== undefined && ["install", "i", "add", "ci", "update", "up", "upgrade", "install-test", "it", "dlx", "create", "init", "view", "info", "publish", "outdated", "audit"].includes(sub)) || (h.cmd === "yarn" && h.args.length === 0);
      if (!installs) continue;
      const custom = h.args.find((a) => a.startsWith("--registry="))?.slice("--registry=".length);
      add(custom ? destinationOf(custom) : { host: "registry.npmjs.org", port: 443 });
    } else if (h.cmd === "pip" || h.cmd === "pip3" || (/^python[\d.]*$/.test(h.cmd) && args[0] === "-m" && args[1] === "pip")) {
      if (args.includes("install") || args.includes("download")) {
        add({ host: "pypi.org", port: 443 });
        add({ host: "files.pythonhosted.org", port: 443 });
      }
    }
  }
  return found;
}

const INTERPRETERS = new Set(["bash", "sh", "zsh", "node", "python", "python3", "tsx", "ruby", "perl", "source", "."]);

/** Reads a file of the workspace by a relative path; null when it is not a readable file. Runs in the sandbox. */
export type ReadWorkspaceFile = (relativePath: string) => Promise<string | null>;

/** Scripts a command invokes: files in the workspace, and package.json scripts for npm. */
async function scriptsOf(readInside: ReadWorkspaceFile, command: string): Promise<{ path: string; content: string }[]> {
  const found: { path: string; content: string }[] = [];
  let pkg: { scripts?: Record<string, string> } | null | undefined;
  const loadPkg = async () => {
    if (pkg === undefined) {
      const text = await readInside("package.json");
      try { pkg = text ? (JSON.parse(text) as { scripts?: Record<string, string> }) : null; } catch { pkg = null; }
    }
    return pkg;
  };
  const add = async (rel: string) => {
    if (found.some((f) => f.path === rel)) return;
    const content = await readInside(rel);
    if (content !== null) found.push({ path: rel, content });
  };

  for (const seg of words(command)) {
    const h = head(seg);
    if (!h) continue;
    if (h.cmd === "npm" || h.cmd === "pnpm" || h.cmd === "yarn") {
      const args = h.args.filter((a) => !a.startsWith("-"));
      const name = args[0] === "run" || args[0] === "run-script" ? args[1] : ["test", "start", "stop", "restart"].includes(args[0] ?? "") ? args[0] : undefined;
      const body = name ? (await loadPkg())?.scripts?.[name] : undefined;
      if (body && name) {
        found.push({ path: `package.json#scripts.${name}`, content: body });
        for (const inner of words(body)) {
          const ih = head(inner);
          const target = ih && (INTERPRETERS.has(ih.cmd) ? ih.args.find((a) => !a.startsWith("-")) : ih.cmd.startsWith(".") ? ih.cmd : undefined);
          if (target) await add(target);
        }
      }
      continue;
    }
    if (INTERPRETERS.has(h.cmd)) {
      const target = h.args.find((a) => !a.startsWith("-"));
      if (target && !target.startsWith("-")) await add(target);
    } else if (seg[0]?.startsWith("./") || seg[0]?.startsWith("scripts/")) {
      await add(seg[0]);
    }
  }
  return found;
}

/** The pipeline's shell call, with the content of any workspace script the command runs. */
export async function shellCall(readInside: ReadWorkspaceFile, command: string): Promise<ShellCall> {
  const scripts = await scriptsOf(readInside, command);
  if (scripts.length === 0) return { kind: "shell", command };
  return {
    kind: "shell",
    command,
    script: { path: scripts.map((s) => s.path).join(", "), content: scripts.map((s) => `# ${s.path}\n${s.content}`).join("\n\n") },
  };
}
