# telepi reference

Everything the [README](../README.md) leaves out: how the parts work, every setting, and the decisions behind them. For what telepi does and does not protect against, see [SECURITY.md](../SECURITY.md).

## Model

- **Project**: a repo with its sandbox and its permanent allows.
- **Task**: one piece of work in a project, with its own conversation, worktree and branch.
- **Request**: something the agent needs from you: an approval, an answer to a question, or a review of a finished task.

The home screen is the queue of open requests across all projects, not a message feed.

## Decisions already made

- No Ask/Auto modes. Each action in a project is `allowed`, `ask until allowed`, or `always ask`. Destructive actions always ask and can never be allowed permanently (the real runtime has none; the class stays in the contract).
- The sandbox is the boundary, so shell commands run without asking. What asks: reading from a host that is not allowed yet, sending data to any host (each method and path), and the review actions that leave the sandbox (push the branch, open a pull request). Those go through a decision pipeline: hard rules first, then judges. Judges can add a question, never remove one. A judge error means "ask". The pipeline also has a pattern list for shell commands (`rm -rf` outside the worktree, force pushes, `curl | sh` and so on); it is off unless `TELEPI_ASK_PATTERNS=1`.
- Approvals are never queued offline; they need a live connection. Messages and new tasks queue on the phone and send on reconnect.
- An unanswered request waits indefinitely.
- The server is the single source of truth. The phone holds a cache of recent state and opens from it instantly.
- Push notifications carry no task content: only what kind of thing is waiting, in which project, and a link.
- The server listens on loopback only and knows nothing about the network in front of it. It pairs devices itself with a one-time code, so it does not depend on that network for authentication.
- A service is an OpenShell provider (it holds the credential, which never enters the sandbox) plus a Pi Durable tool. Actions have a class (`read`, `write`, `destructive`) and the app renders them generically. GitHub is the first: see "Real agent".

## Layout

```
packages/contract   Types and schemas for everything the app and server exchange. The source of truth.
packages/decision   The decision pipeline: rules, pattern list, judge interface.
apps/server         HTTP + WebSocket server, device pairing, web push, state, and the agent runtime seam.
apps/web            The app: React + Vite PWA.
docs/design         The architecture diagram (HTML, open in a browser).
```

Seams between parts:

- `packages/contract/src/index.ts`: app ↔ server.
- `apps/server/src/runtime/types.ts`: server core ↔ agent runtime.
- `apps/web/src/data/api.ts`: screens ↔ data layer.

## Install and run

You need Docker (running), Node 22+, pnpm (`corepack enable pnpm`), git, and a Pi login (run `pi`, then `/login`, once). Then, from a checkout:

```
./install.sh
```

It checks Node and pnpm, runs `pnpm install`, then `pnpm telepi setup`. Nothing installs system software for you: when something is missing, setup stops before changing anything, lists every missing piece and prints the command that installs it on your system.

`setup` checks the rest, makes the telepi home (`~/.telepi`: data, workspaces, config), makes the gateway certificates, starts the OpenShell gateway, builds the app, starts the server and ends with a pairing link and QR code. It is safe to re-run. On your phone: scan the QR code (or open the link) and tap Pair. To install the app and get notifications the phone needs HTTPS: if Tailscale is installed and logged in, `pnpm telepi pair --tailscale` runs `tailscale serve` and uses the https URL; otherwise use a Cloudflare Tunnel and put its URL in `~/.telepi/config.json` as `"publicUrl"`.

| Command | |
| --- | --- |
| `pnpm telepi start` / `stop` / `restart` | Run the server in the background (log: `~/.telepi/server.log`). |
| `pnpm telepi doctor` | Checks the machine, the gateway, the server, your projects and the phone side, and prints the fix for each problem. Changes nothing. Start here when something does not work. |
| `pnpm telepi status` | Gateway, server, URL, model and Pi login. |
| `pnpm telepi pair [--tailscale]` | A fresh pairing code, link and QR. |
| `pnpm telepi project add <path-or-git-url>` | Adds a project (live if the server is running, otherwise by editing `projects.json`). A git URL is cloned to `~/.telepi/repos`. |

`TELEPI_HOME` moves the telepi home. Extra server settings (for example `TELEPI_GITHUB_TOKEN=...`) go in `~/.telepi/env`, one `KEY=VALUE` per line. Setup options: `--port`, `--workspaces`, `--remotes`, `--project`. If a gateway already runs with other workspace folders, setup recreates it.

### Development

```
pnpm install
pnpm dev
```

The dev server (fake agent runtime) listens on `http://127.0.0.1:8787` and prints a pairing code on first start. The app dev server is `http://localhost:5173` and proxies `/api` to the server. `pnpm telepi pair` asks the running server for a fresh code over a local-only endpoint (loopback, no Origin, secret in `<data dir>/local-token`); or start the server with `TELEPI_PAIR=1`. To run without Vite, build the app (`pnpm --filter @telepi/web build`) and the server serves it from the same port. `VITE_MOCK=1 pnpm --filter @telepi/web dev` runs the app alone on sample data.

The fake agent picks a scenario from words in the instruction: `webhook`/`retry` (clean run, then the publish approvals), `cart`/`question` (asks a question), `link`/`docs` (clean run), `upgrade`/`node` (fails), `issue`/`report`/`config` (send-data approval), `blocked`/`outside` (network read approval for a new host).

To use it from a phone, put a private network in front of the server, for example `tailscale serve`, and tell the server its public origin with `TELEPI_PUBLIC_URL`.

The real agent needs more: see "Real agent".

## Conventions

- TypeScript, ESM, strict. Everything in English: code, comments, UI text.
- Validate at the boundary with the schemas from `@telepi/contract`; do not redefine those shapes.
- Keep dependencies few.

## Real agent

`TELEPI_RUNTIME=pi` runs each task with a real model on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), in its own [OpenShell](https://github.com/NVIDIA/OpenShell) sandbox, created over gRPC. OpenShell's supervisor controls the network (default deny); a request it denies becomes an approval card in the app. The fake runtime stays the default.

### Setup by hand

`pnpm telepi setup` does all of this. The manual steps, for when you want control:

1. **Log in to a model provider with Pi.** On the home machine run `pi` and `/login`. telepi reads Pi's own files, fresh each time: `auth.json` (credentials), `models-store.json` (model lists) and `settings.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`), all in `~/.pi/agent` or in `TELEPI_PI_DIR`. All of Pi's built-in providers work. An API key in the usual environment variable (for example `OPENROUTER_API_KEY`) also counts when nothing is stored. Without a usable model a new task fails at once and says to log in with `pi`.
2. **Start the OpenShell gateway** (`deploy/openshell`, see its README). Copy `.env.example` to `.env` there and set two absolute host paths that the gateway mounts at the same path, because a sandbox bind source must exist inside the gateway container: `TELEPI_WORKSPACES` (the server's workspaces root) and `TELEPI_REMOTES` (a directory, or one bare repo, holding project remotes that are local paths, so `git push` works from the sandbox). Run `./gen-certs.sh` once (the gateway uses mutual TLS), then `docker compose up -d`.
3. **Give each project a repository:** add a server-only `repoPath` (absolute path to a git repo that has an `origin` remote) to its entry in `<data dir>/projects.json` while the server is stopped (it rewrites the file). It is never sent to clients.
   ```json
   [{ "id": "demo", "name": "demo", "repoPath": "/Users/me/code/demo" }]
   ```
4. **Start the server:**
   ```
   TELEPI_RUNTIME=pi TELEPI_WORKSPACES=/abs/path/workspaces TELEPI_REMOTES=/abs/path/remotes \
   OPENSHELL_TLS_CA=deploy/openshell/tls/ca.crt OPENSHELL_TLS_CERT=deploy/openshell/tls/client.crt \
   OPENSHELL_TLS_KEY=deploy/openshell/tls/client.key \
   pnpm --filter @telepi/server start
   ```
   The server refuses to start, with a message, if the gateway does not answer.

### Environment

| Variable | Meaning |
| --- | --- |
| `TELEPI_RUNTIME` | `fake` (default) or `pi`. |
| `TELEPI_PI_DIR` | Pi's home directory. Default `~/.pi/agent`. |
| `TELEPI_MODEL` | `provider/modelId` (for example `openrouter/deepseek/deepseek-v4.1-flash`) for new tasks, unless one was chosen in the app. |
| `TELEPI_MAX_TURNS` | Model turns per run. Default 40. |
| `TELEPI_DATA_DIR` | Where the server keeps its state. |
| `TELEPI_WORKSPACES` | Root directory of the task clones. Default `<data dir>/workspaces`. Must be the gateway's mount. |
| `TELEPI_REMOTES` | Root of local project remotes the gateway can see. When set, a project whose local origin is outside it is refused with a clear error. |
| `OPENSHELL_GATEWAY` | The gateway's gRPC address. Default `127.0.0.1:8080`. |
| `OPENSHELL_TLS_CA`, `OPENSHELL_TLS_CERT`, `OPENSHELL_TLS_KEY` | PEM files for the mutual TLS connection (all or none; none means a plaintext gateway). `OPENSHELL_TLS_SERVER_NAME` (default `localhost`) is the name checked on the gateway's certificate. |
| `TELEPI_GITHUB_TOKEN` | A GitHub token that can push and open pull requests. Held by an OpenShell provider; it never enters a sandbox. Without it GitHub origins cannot be pushed. |
| `TELEPI_ASK_PATTERNS` | `1`: shell commands that match the pattern list ask first. Off by default. |
| `TELEPI_GITHUB_API`, `TELEPI_GITHUB_GIT` | For testing only: the GitHub API base (default `https://api.github.com`) and git host base (default `https://github.com`). |

### Which model

A new task runs on, in order: the model chosen in the app (`GET`/`POST /api/models`, kept in `<data dir>/model.json`), then `TELEPI_MODEL`, then Pi's `settings.json` default. The thinking level is Pi's `defaultThinkingLevel`, or off. The model is stored with the task's conversation when it is created, so running tasks keep theirs. The app lists the models of providers that currently have a credential.

### How it works

- Each task gets a clone of the repo in `<workspaces root>/<taskId>` on a branch `agent/<slug>-<id>`, with `origin` set to the project's own origin. The review's file list and the diffs come from that clone.
- The sandbox runs as a non-root user (`node`, uid 1000, which OrbStack maps to your uid on the host, so files the agent writes are yours), has no secrets, and mounts only the workspace (and the origin path, if it is local) at the same absolute paths. OpenShell sandboxes have Landlock as a hard requirement, the workspace and origin in `read_write`, and no network endpoints. Git identity is set through environment variables.
- Everything the agent's tools do runs in the sandbox. `bash` goes through `ExecSandbox`, and so do `read`, `write` and `edit`: every file operation is a small command in the sandbox (`cat`, `tee`, `find`, `mkdir`, with file content over stdin and stdout), so Landlock decides what a path may be and the server process never opens a path the agent chose.
- The system prompt is telepi's short one, plus the workspace's `AGENTS.md` (read through the sandbox, capped at 20 KB) as its own section.
- Git on the agent's clone: the agent can write `.git/config`, hooks and `.gitattributes`, and git runs what those name. So while the sandbox lives, the commands that inspect the work run in the sandbox. On the host, git never runs in the clone after the agent has been in it: for diffs after the sandbox is gone (a finished task, a restart) telepi makes a bare repository of its own (`<data dir>/pi/views/<task>.git`, telepi's config, no hooks, no working tree) whose object store points at the clone's objects through `objects/info/alternates`. The view is refused if the clone's `.git` or `.git/objects` is a symlink or borrows objects from elsewhere.
- Shell commands run without asking. With `TELEPI_ASK_PATTERNS=1` the ones that match the pattern list (see the last section) ask first.
- Network access, per task:
  - A command that plainly targets a host (`curl`/`wget` URLs, the remote of `git clone/fetch/pull/push`, `npm`/`pnpm`/`yarn` installs, `pip install`) is put to the user **before it runs** ("Allow reading from example.com"; several hosts of one command, or requests that arrive together, share one card with a section per host). On approval telepi adds the rule to the sandbox's policy through the gateway (`UpdateConfig`), waits until the sandbox reports the new policy version as loaded (up to ten seconds: the supervisor polls for changes), and then runs the command. On denial the command is not run.
  - Anything telepi cannot see in advance (a script, `node -e "fetch(...)"`) is refused by the supervisor. The supervisor's log stream reports the denial about half a second later and opens the card; the gateway's pending "draft chunks" (about eight seconds later) are a second source for the same thing and are only ever rejected, never approved: telepi adds the rule itself. The failed command's output gets a plain `[telepi]` line saying network access is closed by policy, the user has been asked, and the model must not try other hosts or tools. When the user approves, the model is told "it is open now" only after the sandbox has loaded the rule.
  - Approving a web host (ports 80, 443, 8080, 8443) opens it for reading only: GET, HEAD, OPTIONS and git's fetch protocol. Any other request (a POST, `git push`, an upload) is refused by the supervisor, which ends TLS itself and reads the request, and becomes a second card: "Allow sending data to github.com", with the method and path. Approving adds a rule for that method and path; a path segment that is only digits becomes `*`. Ports that are not web ports cannot be inspected, so approving one opens it fully, and the card says so.
  - A host that was denied is never asked about again in the task. The card offers "deny all network access for this task": after that every request is refused without asking, the model is told once, and the review lists the refused hosts in its notes. "Always allow in this project" remembers a single host for reading (`network:<host>:<port>`) or a single send (`network.send:<METHOD>:<host>:<port><path>`) in the initial policy of the project's future sandboxes.
  - A denial reported while the run is ending is waited for (up to 12 s after a command failed like one) before the review opens. One that arrives after the review opened is refused and noted on that review (or the next).
  - Rules approved so far are in the sandbox's policy, which survives a restart of the sandbox, but not the server restarting a task (the sandbox is then created again with the project's permanent hosts only).
- Timeouts and aborts: OpenShell's own exec timeout and cancelling the gRPC stream do **not** kill the command (verified). telepi wraps each command in a small watchdog that kills the command and its descendants when the timeout or abort fires. A process that detached before that (`setsid`, double fork) is out of its reach, so after a timeout or abort telepi looks, in a new exec, for processes younger than the command that are still alive. If there is one, it stops and starts the sandbox (about a second): that ends every process, keeps the workspace, the network policy with the approved rules and attached providers, and loses running processes and anything held in memory. The tool result tells the model the sandbox was restarted.
- Conversations live in `<data dir>/pi/session.sqlite`. After a server restart, running tasks resume from Pi Durable's checkpoints, the sandbox is recreated, and a review that was open stays open; sandboxes a crashed server left behind are removed at start.
- Token usage and cost of each run are logged to the server log.

### Publishing

A finished review that changed files offers two actions, both class `write`: they ask the first time in a project, and the approval can be allowed permanently for the project. Both run **inside the sandbox**.

- **Push branch** (`git.push`): `git push origin <branch>`. For a local-path origin (mounted through `TELEPI_REMOTES`) no credential is involved. For an `https://github.com/...` origin it needs `TELEPI_GITHUB_TOKEN`.
- **Open PR** (`github.open_pr`): offered only when the origin is on github.com and a token is set. It pushes the branch, then creates the pull request with the REST API (`POST /repos/{owner}/{repo}/pulls`, base = the repo's default branch as recorded when the workspace was made) and reports the URL GitHub returns.
- The agent can do the same through its `open_pull_request(title, body)` tool, with the same approval. The system prompt tells it to use that tool rather than `git push` to a hosted remote.

The GitHub token is held by an OpenShell provider (made again at each server start from `TELEPI_GITHUB_TOKEN`). While a push or a pull request runs, the provider is attached to that task's sandbox (up to about ten seconds, the supervisor's poll), and detached in the background once the push or pull request is done; the agent does not run again until the detach has finished. Before attaching, telepi checks the sandbox for processes the agent left running and restarts the sandbox if there are any. The sandbox sees only a placeholder in an environment variable; the supervisor swaps in the real token on the wire: as `Authorization: Basic base64("x-access-token:<token>")` for git over HTTPS to github.com, and as `Authorization: Bearer <token>` for api.github.com. Verified against real github.com with a private repository: push and pull request from the review, with nothing of the token visible in the sandbox.

**Which token.** Use a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to the repositories you add to telepi, with **Contents: Read and write** and **Pull requests: Read and write** and nothing else. Put it in `~/.telepi/env` as `TELEPI_GITHUB_TOKEN=...` and run `pnpm telepi restart`. A classic token or the one `gh auth token` prints usually reaches every repository you have; it never enters the sandbox, but a narrow token limits what a mistake on the trusted side could do.

### Extensions

`<data dir>/extensions.json` is an array of module specifiers (absolute paths or package names) to load at start:

```json
["/Users/me/telepi-extensions/notes.mjs", "my-durable-extension"]
```

Each module's default export is a Pi Durable `Extension` (or an array of them). They are installed after telepi's own. A missing file means none; a module that fails to load is named in the log and skipped, and the server still starts. Extension code runs in the server process with the server's rights, outside the sandbox: only list code you trust. Package names resolve from `apps/server`. Pi Durable's extension API is experimental and may change.

## Checking the decision pipeline

The pipeline runs for shell commands only with `TELEPI_ASK_PATTERNS=1`, and always for the review actions.

`pnpm --filter @telepi/server check:decisions` pushes a fixed list of shell commands and actions (force pushes, `rm -rf` inside and outside the worktree, SQL drops, `DELETE` without `WHERE`, `curl | sh`, harmless commands, destructive, first-time and allowed actions) through the real pipeline with the real pattern judge and prints a table of call, outcome, stage and reason. It is a manual check, not a test suite: read it.
