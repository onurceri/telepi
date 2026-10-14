# Security

telepi lets a coding agent work on your machine while you are away from it. This page says what protects you, what does not, and how to report a problem.

## What the design relies on

- **The sandbox is the boundary.** Every command and file operation of the agent runs in an NVIDIA OpenShell sandbox, one per task, that sees a clone of the project and nothing else of the host. telepi does not try to recognise dangerous commands; what stays inside the sandbox needs no permission.
- **Network is refused by default, and approving a site means read access.** A connection to a host the project has not allowed is refused by the sandbox's supervisor and becomes an approval on your phone. Approving a web host (ports 80, 443, 8080, 8443) lets the agent read from it: GET, HEAD, OPTIONS and git's fetch/clone protocol. Everything else (POST, PUT, PATCH, DELETE, `git push`, `npm publish`, uploads) is refused by the supervisor, which reads each request after ending TLS itself, and becomes a second card showing the host, method and path. Allowing that adds a rule for that one method and path (a path segment that is only digits becomes `*`). "Always allow in this project" is stored the same way as host approvals. Ports that are not web ports cannot be inspected, so approving one opens it for any traffic both ways, and the card says so. Limits: reads can still carry data out in a URL to a site you approved; a read-only site that accepts data through GET is not protected; downloads and uploads are not told apart on non-web ports; POSTs that only read (GraphQL, git-lfs batch) ask like any other send. The GitHub publish actions attach a provider that opens github.com fully for the length of the push only.
- **Credentials stay outside the sandbox.** The model login is read by the server from Pi's own files. A service token (GitHub) is held by an OpenShell provider; the sandbox sees a placeholder and the supervisor fills in the real value on requests to that service only. The provider is attached only while a publish action runs.
- **One inbound connection.** The server listens on loopback. You put a private network in front of it (Tailscale, Cloudflare Access). The server still pairs each device itself with a one-time code and does not trust that network for authentication.
- **The CLI's local endpoints need a secret.** `pnpm telepi pair` and `project add` talk to the server on `/api/local/*`, which answers only a loopback request without an `Origin` header that carries the random token in `<data dir>/local-token` (mode 0600, new at every start). Loopback alone is not trusted, because `tailscale serve` and other proxies also connect from loopback. Anyone who can read your files as your user can pair a device.
- **Publishing asks.** Pushing a branch and opening a pull request ask the first time in a project.
- **Notifications carry no task content.** The push service learns that something is waiting and in which project.

## What does not protect you

- **The trusted side is trusted.** The telepi server, Pi Durable and any Durable extension you list in `extensions.json` run with your user's rights and can read the model login. Only load extensions you have read.
- **The OpenShell gateway mounts the Docker socket.** Whoever controls the gateway controls Docker on the host. Its API is protected by mutual TLS; keep the client key private.
- **An allowed host can be read in full.** Read rules are per host. If you allow `github.com` for a project, the agent can read any public repository there, and a prompt-injected agent can carry data out in the URLs it requests from that host.
- **Leftover processes and publishing.** Before a publish attaches the GitHub provider, telepi looks for processes the agent left running in the sandbox and restarts the sandbox if it finds any. During the agent's own `open_pull_request` tool the agent is running, so its other commands could run while the provider is attached.
- **The agent can change what you review.** It writes the code and the summary. Read the diff before you publish.
- **A project's own scripts run in the sandbox,** including git hooks and package install scripts. They cannot reach the host, but they can use whatever network the project has been allowed.
- **The optional pattern list (`TELEPI_ASK_PATTERNS=1`) is a convenience, not a control.** It is easy to write a command it does not recognise.
- **Pi Durable is experimental** and OpenShell is young. telepi pins their versions; review upgrades.

## Not yet verified

Verified on a real gateway: read-only approval (a `git clone` from github.com worked, a POST to the same kind of host was refused with `policy_denied` and raised a send card, a `git push` to github.com raised its own card), credential injection against a local stand-in for GitHub (the stand-in received the real token, the sandbox saw a placeholder), and the provider being detached before the agent runs again. Also verified against real github.com with a private repository: the agent's own `git push` stopped at GitHub's login prompt because the sandbox holds no credential (no GitHub variable and no token file in the sandbox); pushing the branch and opening pull requests from the review worked, with the token supplied by OpenShell only while each ran; the provider was gone after the task ended and was removed from the gateway when the server started without a token. There has been no systematic attempt to break out of the sandbox yet. A phone behind Tailscale or Cloudflare Access, and OAuth model logins that need refreshing have not been exercised. Linux hosts are untested; development so far was on macOS with OrbStack.

## Reporting a problem

Please do not open a public issue for a vulnerability. Report it privately through the repository's **Security** tab ("Report a vulnerability"), with what you found and how to reproduce it.
