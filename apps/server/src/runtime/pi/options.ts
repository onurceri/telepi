// Configuration of the Pi runtime and the constants it shares across modules.
import type { Extension } from "@earendil-works/pi-durable";
import type { PluginAction } from "@telepi/contract";
import type { GithubConfig } from "./github";
import type { ModelCatalog } from "./models";
import type { SandboxBackend } from "./sandbox";

export interface PiOptions {
  dataDir: string;
  /** Where the sandboxes run: OpenShell. */
  backend: SandboxBackend;
  /** Root directory of the task workspaces (clones). The gateway must mount this same path. */
  workspacesDir: string;
  /** Root of local project remotes the OpenShell gateway can see; when set, a project whose local origin is outside it is refused. */
  remotesDir?: string;
  /** Pi's models, login and defaults. */
  catalog: ModelCatalog;
  /** Absolute path of the project's git repository, if the project has one. */
  repoPath(projectId: string): string | undefined;
  /** Model turns allowed per run (one run = one instruction or one round of requested changes). */
  maxTurns?: number;
  /** Ask before shell commands that match the pattern list. */
  askPatterns: boolean;
  /** GitHub, when the server has a token. */
  github: GithubConfig | null;
  /** Durable extensions loaded from <data dir>/extensions.json, installed after telepi's own. */
  extensions: Extension[];
}

export const DEFAULT_MAX_TURNS = 40;

export const SHELL_ACTION: PluginAction = { id: "shell.run", plugin: "shell", label: "Run command", class: "write" };
export const PUSH_ACTION: PluginAction = { id: "git.push", plugin: "git", label: "Push branch", class: "write" };
export const OPEN_PR_ACTION: PluginAction = { id: "github.open_pr", plugin: "github", label: "Open PR", class: "write" };

const NETWORK =
  "The sandbox's network is closed by default. A command that plainly reaches a host (curl, git clone, npm install) is put to the user before it runs, and runs once they approve. A request the sandbox refuses is also put to the user. If one is refused or denied, do not try other hosts or other tools to get around it: say so in your final message.";

export function systemPrompt(opts: { github: boolean }): string {
  const publish = opts.github
    ? "To publish your work to a GitHub remote, call open_pull_request; do not run git push yourself against a hosted remote, the sandbox has no credential for it. The user is asked before it runs."
    : "Do not push your branch; the user publishes it from the review.";
  return `You are a coding agent working in a sandboxed git clone on your own branch. Your tools act inside the sandbox, in the current directory.

- If the repository has an AGENTS.md, it follows below. Follow it.
- Make the change, run the tests, and commit your work with git.
- Ask the user (ask_user) only when the instruction leaves a real decision to them. Do not ask about things you can find out or decide yourself.
- Never invent results. Report what you actually ran and saw.
- Never invent data. When the task needs facts from outside the repository (published rates, prices, versions, a vendor's files) and you cannot obtain them, change nothing that depends on them: try the source the repository names, and if that is refused or unavailable, ask the user or report that it could not be done. Estimated or made-up values are worse than no change.
- If you cannot complete the task, call report_failure with the exact reason, then say the same in your final message.
- ${NETWORK} ${publish}
- Keep messages to the user short and plain. Your final message is the summary the user reviews: say what changed, how you checked it, and anything left open.`;
}
