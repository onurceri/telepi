// Git on the host: preparing a task's workspace, and reading and publishing what the agent did.
// The agent can write anything inside the workspace, including .git/config, .git/hooks and .gitattributes, and git
// runs programs that those name. So the host never runs git inside the agent's clone after the agent has been there:
//  - While the sandbox lives, the commands that inspect the agent's work (numstat, per-file diff, leftover commit) run
//    inside the sandbox (see sandboxGit), under Landlock, where running what the repo names does no harm.
//  - On the host, a "view" is used instead: a bare repository that telepi creates itself (its config is telepi's, it has
//    no hooks and no working tree) whose object store points at the clone's objects through `objects/info/alternates`.
//    Git only reads objects (data) from the clone, never its config, hooks or attributes. Diffs after the sandbox is
//    gone run in the view. Pushing is not done here: it runs in the sandbox (see github.ts).
import { execFile } from "node:child_process";
import { lstat, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileChange } from "@telepi/contract";

const SAFE_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.sshCommand=ssh",
  "-c", "protocol.ext.allow=never",
  "-c", "diff.external=",
];

const SAFE_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh", GIT_EXTERNAL_DIFF: "", GIT_PAGER: "cat" };

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd`. Never rejects on a non-zero exit; the caller decides. Only for repositories telepi trusts. */
export function git(cwd: string, args: string[], opts: { signal?: AbortSignal; input?: string; gitDir?: string } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      [...SAFE_CONFIG, ...(opts.gitDir ? ["--git-dir", opts.gitDir] : []), ...args],
      { cwd, env: { ...process.env, ...SAFE_ENV }, maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr: error && code === 1 && !stderr ? error.message : stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");

export function branchNameFor(taskId: string, title: string): string {
  const short = taskId.replace(/^task_/, "").slice(0, 6);
  return `agent/${slugOf(title) || "task"}-${short}`;
}

export interface Workspace {
  dir: string;
  branch: string;
  base: string;
  /** The project repo's own origin URL; pushes go there. */
  originUrl: string;
  /** The project repo's default branch: the one origin/HEAD names, else the one checked out. */
  defaultBranch: string;
}

/** The directory a git remote URL points at when it is local, else null. */
export function localOriginPath(url: string): string | null {
  if (url.startsWith("file://")) return decodeURIComponent(new URL(url).pathname);
  return path.isAbsolute(url) ? url : null;
}

/** A self-contained clone of the project repo, origin pointing at the repo's own origin, on a fresh task branch. */
export async function prepareWorkspace(opts: { repoPath: string; dir: string; taskId: string; title: string }): Promise<Workspace> {
  const { repoPath, dir } = opts;
  if (!path.isAbsolute(repoPath)) throw new Error(`repoPath must be absolute: ${repoPath}`);
  const remote = await git(repoPath, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) throw new Error(`The repository at ${repoPath} has no "origin" remote.`);
  let originUrl = remote.stdout.trim();
  if (!originUrl.includes("://") && !path.isAbsolute(originUrl) && !originUrl.includes("@")) originUrl = path.resolve(repoPath, originUrl);

  await mkdir(path.dirname(dir), { recursive: true });
  await gitOk(path.dirname(dir), ["clone", "--quiet", repoPath, dir]);

  // Keep the project repo's local branches (they can differ from the remote's), then learn the remote's real state.
  const refs = (await gitOk(dir, ["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"])).split("\n").filter((r) => r && r !== "HEAD");
  const current = (await gitOk(dir, ["branch", "--show-current"])).trim();
  for (const ref of refs) if (ref !== current) await git(dir, ["branch", "--no-track", ref, `refs/remotes/origin/${ref}`]);
  await gitOk(dir, ["remote", "set-url", "origin", originUrl]);
  const fetched = await git(dir, ["fetch", "--quiet", "origin"]);
  if (fetched.code !== 0) console.warn(`telepi: could not fetch origin for ${opts.taskId}: ${fetched.stderr.trim()}`);

  const originHead = (await git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "");
  const defaultBranch = originHead || current || "main";

  const base = (await gitOk(dir, ["rev-parse", "HEAD"])).trim();
  const branch = branchNameFor(opts.taskId, opts.title);
  await gitOk(dir, ["checkout", "--quiet", "-b", branch]);
  return { dir, branch, base, originUrl, defaultBranch };
}

/** Runs a git command somewhere (in the sandbox, or in a view) and says what it printed. */
export type GitRunner = (args: string[]) => Promise<GitResult>;

/** Git inside the task's sandbox, in the workspace. Whatever the clone's config or hooks name runs under Landlock. */
export function sandboxGit(run: (argv: string[]) => Promise<GitResult>): GitRunner {
  return (args) => run(["git", "--no-pager", ...args]);
}

const SHA = /^[0-9a-f]{40}$/;
export const isSha = (s: string) => SHA.test(s);

/**
 * The host-side view of a clone (see the top of this file): a bare repo of telepi's own whose objects are the clone's.
 * Refuses a clone whose `.git` or `.git/objects` is a symlink, or whose object store borrows from another one, since
 * either would make the view read objects from somewhere the agent chose.
 */
export async function hostView(opts: { dataDir: string; taskId: string; workspace: string }): Promise<{ run: GitRunner; dir: string }> {
  const dir = path.join(opts.dataDir, "pi", "views", `${opts.taskId}.git`);
  const objects = path.join(opts.workspace, ".git", "objects");
  for (const p of [path.join(opts.workspace, ".git"), objects]) {
    const info = await lstat(p).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`The workspace's ${path.relative(opts.workspace, p)} is not a plain directory, so telepi will not read it.`);
  }
  if (await lstat(path.join(objects, "info", "alternates")).then(() => true, () => false)) {
    throw new Error("The workspace's object store points at another one (objects/info/alternates), so telepi will not read it.");
  }
  if (!(await stat(path.join(dir, "HEAD")).then(() => true, () => false))) {
    await mkdir(path.dirname(dir), { recursive: true });
    const made = await git(path.dirname(dir), ["init", "--bare", "--quiet", "--template=", dir]);
    if (made.code !== 0) throw new Error(`Could not create a view of the workspace: ${made.stderr.trim()}`);
  }
  await mkdir(path.join(dir, "objects", "info"), { recursive: true });
  await writeFile(path.join(dir, "objects", "info", "alternates"), `${objects}\n`);
  return { dir, run: (args) => git(dir, args, { gitDir: dir }) };
}

/** Files changed between the base commit and `head`. */
export async function changedFiles(run: GitRunner, base: string, head: string): Promise<FileChange[]> {
  const r = await run(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", `${base}..${head}`]);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  const files: FileChange[] = [];
  for (const entry of r.stdout.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (m) files.push({ path: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return files;
}

/** The diff of one file against the base commit, hunks only. Null when the file is not among the changes. */
export async function fileDiff(run: GitRunner, base: string, head: string, file: string): Promise<{ binary: boolean; patch: string } | null> {
  const files = await changedFiles(run, base, head);
  const hit = files.find((f) => f.path === file);
  if (!hit) return null;
  const r = await run(["diff", "--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", `${base}..${head}`, "--", file]);
  if (r.code !== 0) return null;
  const lines = r.stdout.split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first === -1) return { binary: /^Binary files /m.test(r.stdout) || (hit.added === 0 && hit.removed === 0 && /GIT binary patch|Binary files/.test(r.stdout)), patch: "" };
  return { binary: false, patch: lines.slice(first).join("\n").replace(/\n$/, "") };
}
