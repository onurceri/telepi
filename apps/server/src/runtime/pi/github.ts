// GitHub, as an OpenShell provider plus two operations that run inside the sandbox: push the branch, and push it and
// open a pull request. The token lives in an OpenShell provider on the gateway. The sandbox sees only a placeholder in
// an environment variable; the supervisor swaps in the real token on the wire, for git over HTTPS (Basic) and for the
// REST API (Bearer). The provider is attached to a task's sandbox only while one of these operations runs.
import type { OpenShellClient } from "./openshell/client";
import type { OpenShellControl } from "./openshell/control";
import { localOriginPath } from "./git";
import type { TaskMeta } from "./store";

export interface GithubConfig {
  token: string;
  /** REST API base, e.g. https://api.github.com */
  apiUrl: string;
  /** Git host base, e.g. https://github.com */
  gitUrl: string;
}

export const GITHUB_PROVIDER = "telepi-github";
export const GITHUB_PROFILE = "telepi-github";
// Two variables, one secret: a credential has one auth style, and git wants Basic where the API wants Bearer.
const GIT_VAR = "GITHUB_GIT_TOKEN";
const API_VAR = "GITHUB_API_TOKEN";

const endpointOf = (url: string) => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)), protocol: "rest", access: "NETWORK_ACCESS_PRESET_FULL", enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE" };
};

/** Removes the provider and its profile, so a token that is no longer configured does not stay in the gateway. */
export async function removeGithubProvider(client: OpenShellClient): Promise<void> {
  await client.deleteProvider(GITHUB_PROVIDER);
  if (await client.hasProfile(GITHUB_PROFILE)) await client.deleteProfile(GITHUB_PROFILE);
}

/** Makes the provider profile and the provider that holds the token, with the token this server has now. */
export async function ensureGithubProvider(client: OpenShellClient, github: GithubConfig): Promise<void> {
  // Made again each start: the token, or the hosts, may have changed since the last one.
  await removeGithubProvider(client);
  await client.importProfile({
    id: GITHUB_PROFILE,
    display_name: "GitHub",
    description: "telepi: push to GitHub over HTTPS and open pull requests through the REST API",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [
      { name: "git", description: "GitHub token for git over HTTPS", env_vars: [GIT_VAR], required: true, auth_style: "basic", header_name: "authorization" },
      { name: "api", description: "GitHub token for the REST API", env_vars: [API_VAR], required: true, auth_style: "bearer", header_name: "authorization" },
    ],
    endpoints: [endpointOf(github.gitUrl), endpointOf(github.apiUrl)],
    binaries: [{ path: "/usr/bin/git" }, { path: "/usr/lib/git-core/git-remote-http" }, { path: "/usr/bin/curl" }],
  });
  await client.createProvider(GITHUB_PROVIDER, GITHUB_PROFILE, { [GIT_VAR]: github.token, [API_VAR]: github.token });
}

/** `owner/repo` of a remote URL when it is on the configured git host (https or ssh form), else null. */
export function githubRepoOf(originUrl: string, github: Pick<GithubConfig, "gitUrl">): { owner: string; repo: string } | null {
  const { host, hostname } = new URL(github.gitUrl);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = "([^/]+)/([^/]+?)(?:\\.git)?/?$";
  const forms = [new RegExp(`^[a-z][a-z0-9+.-]*://(?:[^@/]+@)?${escape(host)}/${tail}`, "i"), new RegExp(`^[\\w.-]+@${escape(hostname)}:${tail}`, "i")];
  for (const re of forms) {
    const m = re.exec(originUrl);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  return null;
}

/** What the review and the agent's tool can do with this task's origin. */
export function publishingOf(meta: TaskMeta, github: GithubConfig | null): { push: boolean; pr: { owner: string; repo: string } | null; note: string | null } {
  const repo = github ? githubRepoOf(meta.originUrl, github) : null;
  if (repo) return { push: true, pr: repo, note: null };
  if (localOriginPath(meta.originUrl)) return { push: true, pr: null, note: null };
  const onGithub = /github\.com[:/]/i.test(meta.originUrl);
  return { push: false, pr: null, note: onGithub ? "This project's origin is on GitHub, but the server has no GitHub token (TELEPI_GITHUB_TOKEN), so the branch cannot be pushed from here." : `Pushing to ${meta.originUrl} is not set up in telepi, so the branch cannot be pushed from here.` };
}

const pushUrlOf = (github: GithubConfig, repo: { owner: string; repo: string }) => `${github.gitUrl}/${repo.owner}/${repo.repo}.git`;

export function pushDetail(meta: TaskMeta, github: GithubConfig | null, fileCount: number): string {
  const repo = github ? githubRepoOf(meta.originUrl, github) : null;
  const where = repo && github ? pushUrlOf(github, repo) : meta.originUrl;
  return [`Push the branch ${meta.branch} to ${where}.`, "", `${fileCount} file${fileCount === 1 ? "" : "s"} changed against ${meta.base.slice(0, 10)}. The push runs inside the sandbox.`, repo ? "The GitHub token stays outside the sandbox: its supervisor adds it to the request." : ""].join("\n").trimEnd();
}

export function prDetail(meta: TaskMeta, github: GithubConfig, repo: { owner: string; repo: string }, input: PrInput): string {
  return [
    `Push the branch ${meta.branch} to ${pushUrlOf(github, repo)}, then open a pull request into ${meta.defaultBranch ?? "main"}.`,
    "",
    `Title: ${input.title}`,
    input.body.trim() ? `\n${input.body.trim()}` : "",
    "",
    "Both run inside the sandbox. The GitHub token stays outside it: the sandbox's supervisor adds it to the requests.",
  ].join("\n").trim();
}

export interface PrInput {
  title: string;
  body: string;
}

type Run = OpenShellControl["run"];

/** Fails with the tail of what git or curl said. `secret` never appears in the message. */
function failure(what: string, r: Awaited<ReturnType<Run>>, secret?: string): Error {
  const raw = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(-400);
  const text = secret ? raw.replaceAll(secret, "[token]") : raw;
  return new Error(`${what}${r.outcome.kind === "exit" ? ` (exit ${r.outcome.code})` : ` (${r.outcome.kind})`}${text ? `: ${text}` : "."}`);
}

/** Told what a publish is doing, in words for the phone. */
export type Progress = (text: string, detail?: string | null) => void;

/**
 * Attaches the GitHub provider to the sandbox for the length of `work`. With `inReview` (the agent is idle, waiting
 * for the user's answer), the detach is left running in the background and the caller can go on: the control holds
 * back everything that could run the agent until it is done. Otherwise (the agent's own tool) it is waited for.
 */
async function withProvider<T>(control: OpenShellControl, mode: { inReview: boolean; progress?: Progress }, work: () => Promise<T>): Promise<T> {
  if (mode.inReview) {
    // The credential must only meet commands of telepi's own. A process the agent left running (a background job, a
    // command that detached) would be there while it is attached, and only restarting the sandbox ends it.
    const strays = await control.strayProcesses().catch(() => ["unknown"]);
    if (strays.length > 0) {
      mode.progress?.("Stopping what the agent left running");
      await control.recycle();
    }
  }
  mode.progress?.("Connecting to GitHub");
  await control.attachProvider(GITHUB_PROVIDER);
  try {
    return await work();
  } finally {
    if (mode.inReview) control.detachProviderLater(GITHUB_PROVIDER);
    else await control.detachProvider(GITHUB_PROVIDER).catch((e: Error) => console.warn(`telepi: could not detach ${GITHUB_PROVIDER}:`, e.message));
  }
}

/** The push itself. For a GitHub origin the provider must be attached by the caller. */
async function runPush(control: OpenShellControl, meta: TaskMeta, github: GithubConfig | null): Promise<void> {
  const repo = github ? githubRepoOf(meta.originUrl, github) : null;
  if (!github || !repo) {
    // A local origin: mounted into the sandbox, no credential involved.
    const r = await control.run({ argv: ["git", "push", "origin", meta.branch], cwd: meta.workspace, timeoutMs: 120_000 });
    if (r.outcome.kind !== "exit" || r.outcome.code !== 0) throw failure("The push failed", r);
    return;
  }
  // $GITHUB_GIT_TOKEN holds only a placeholder in the sandbox; the supervisor swaps it for the token in the request.
  const script = `git -c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$${GIT_VAR}" | base64 -w0)" push "$1" "$2"`;
  const r = await control.run({ argv: ["bash", "-c", script, "push", pushUrlOf(github, repo), meta.branch], cwd: meta.workspace, timeoutMs: 120_000 });
  if (r.outcome.kind !== "exit" || r.outcome.code !== 0) throw failure("The push failed", r, github.token);
}

/** `git push origin <branch>` inside the sandbox; for a GitHub origin, with the token supplied by the supervisor. */
export async function pushBranch(opts: { control: OpenShellControl; meta: TaskMeta; github: GithubConfig | null; progress?: Progress }): Promise<string> {
  const { control, meta, github, progress } = opts;
  const pushing = () => { progress?.(`Pushing ${meta.branch}`); return runPush(control, meta, github); };
  // Only the review publishes a branch on its own, so this always runs while the agent is idle.
  if (github && githubRepoOf(meta.originUrl, github)) await withProvider(control, { inReview: true, progress }, pushing);
  else await pushing();
  return `Pushed ${meta.branch}.`;
}

/** Pushes the branch, then creates the pull request through the REST API, both from inside the sandbox. */
export async function openPullRequest(opts: { control: OpenShellControl; meta: TaskMeta; github: GithubConfig; repo: { owner: string; repo: string }; input: PrInput; inReview?: boolean; progress?: Progress }): Promise<{ url: string; number: number | null }> {
  const { control, meta, github, repo, input, progress } = opts;
  const body = JSON.stringify({ title: input.title, body: input.body, head: meta.branch, base: meta.defaultBranch ?? "main" });
  // One attach for both requests: attaching and detaching each take about ten seconds.
  const reply = await withProvider(control, { inReview: opts.inReview === true, progress }, async () => {
    progress?.(`Pushing ${meta.branch}`);
    await runPush(control, meta, github);
    progress?.("Opening pull request");
    const script = `curl -sS -m 30 -w '\\n%{http_code}' -X POST -H "Authorization: Bearer $${API_VAR}" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' -H 'User-Agent: telepi' -H 'content-type: application/json' --data "$1" "$2"`;
    const r = await control.run({ argv: ["bash", "-c", script, "pr", body, `${github.apiUrl}/repos/${repo.owner}/${repo.repo}/pulls`], cwd: meta.workspace, timeoutMs: 60_000 });
    if (r.outcome.kind !== "exit" || r.outcome.code !== 0) throw failure("The pull request request failed", r, github.token);
    return r.stdout;
  });
  const cut = reply.lastIndexOf("\n");
  const status = reply.slice(cut + 1).trim();
  // A server may echo the request back, headers included; whatever is shown from the reply has the token taken out.
  const text = reply.slice(0, cut).replaceAll(github.token, "[token]");
  let json: { html_url?: unknown; number?: unknown; message?: unknown; errors?: { message?: unknown }[] } = {};
  try { json = JSON.parse(text) as typeof json; } catch { /* not JSON */ }
  if (!/^2\d\d$/.test(status)) {
    const why = [json.message, json.errors?.[0]?.message].filter((x): x is string => typeof x === "string").join(": ");
    throw new Error(`GitHub answered HTTP ${status}${why ? `: ${why}` : ""}. The branch was pushed.`);
  }
  if (typeof json.html_url !== "string") throw new Error(`GitHub answered HTTP ${status} without a pull request URL. The branch was pushed.`);
  return { url: json.html_url, number: typeof json.number === "number" ? json.number : null };
}
