# OpenShell in Docker

The OpenShell gateway telepi talks to, and the field notes behind telepi's OpenShell adapter. `pnpm telepi setup` runs this for you; read on if you want to know what OpenShell does and does not do, as observed, or run it by hand.

NVIDIA OpenShell `v0.1.3` (gateway, supervisor and sandbox images pinned to `0.1.3`), running entirely in Docker
on macOS / OrbStack. Nothing is installed on the host. Everything here was run and observed on
2026-10-12 (OrbStack, Docker 29.8.2, Linux kernel `7.2.9-orbstack`, arm64) unless marked **unverified**.

## What is in this directory

| File | Purpose |
|---|---|
| `compose.yaml` | Compose project `telepi-openshell`: `init` (JWT keys), `gateway`, and on-demand `cli` (profile `tools`) and `echo` (profile `spike`). |
| `gateway.toml` | Gateway config (Docker compute driver, mutual TLS, no unauthenticated users, bind mounts enabled). |
| `gen-certs.sh` | Makes the CA, the gateway's server certificate and the telepi server's client certificate into `tls/` (git-ignored), with openssl in a container. Also lays the client bundle out for the CLI container (`tls/cli`). |
| `Dockerfile.cli` | `openshell` CLI (static musl binary from the v0.1.3 release) + `openssh-client`. Used as the `cli` service. |
| `.env` (copy of `.env.example`, not committed) | `TELEPI_WORKSPACES` and `TELEPI_REMOTES`: host paths the gateway mounts at the same path so sandboxes may bind-mount them (see "Using it from telepi"). |
| `policies/dev.yaml` | Sandbox policy: Landlock hard requirement, `/workspace` read-write, no network rules. |
| `policies/echo-api.yaml` | Provider profile used for the credential-injection test. |
| `examples/grpc-client.mjs` | Plain gRPC client (Node, `@grpc/grpc-js`) covering create / exec / approvals / delete. |
| `work/` | Git-ignored scratch dir. CLI working dir (`/work`). The spike examples below bind-mounted it: set `TELEPI_WORKSPACES` to its absolute path to run them. |

## Bring up / down

```sh
cd deploy/openshell
./gen-certs.sh                       # once: CA, server and client certificates in tls/ (FORCE=1 replaces them)
docker compose up -d                 # init (one-shot) + gateway; images are pulled on first run
curl -s http://127.0.0.1:8081/readyz # {"status":"healthy","version":"0.1.3","checks":{"database":{"status":"healthy",...}}} (health stays plain HTTP)
docker compose build cli             # once: builds the CLI image
docker compose run --rm -T --no-deps cli status
#   Status: Connected / Authentication: Authenticated (mTLS transport) / Version: 0.1.3
docker compose down                  # stops the gateway; state survives (see Lifecycle)
```

Shorthand used below: `os() { docker compose run --rm -T --no-deps cli "$@"; }` (run from this directory).
The `cli` service sets `OPENSHELL_GATEWAY_ENDPOINT=http://gateway:8080` (compose network), so no `gateway add` is needed.

Ports (all `127.0.0.1` only): `8080` gRPC API, `8081` health (`/healthz`, `/readyz`).
**8080 must stay 8080**: the Docker driver tells sandbox supervisors to call back on the gateway's own bind port via the
host-network loopback, so remapping the published port makes sandboxes fail with
`Docker supervisor exited before becoming ready ... failed to connect to OpenShell server` (hit and confirmed).

### Privileges and what they imply

- The gateway mounts `/var/run/docker.sock` and runs as UID 0. **Anything that can reach the gateway API or the
  container can create arbitrary sibling containers on the OrbStack Docker daemon** (DooD, not DinD; not `--privileged`).
- **Mutual TLS is on** (verified): `[openshell.gateway.tls]` has the server certificate and a `client_ca_path`,
  `[openshell.gateway.mtls_auth] enabled = true`, `allow_unauthenticated_users = false`, and `guest_tls_ca` is the CA that
  supervisors check the gateway with (the Docker driver passes its content into the supervisor container). The certificates come
  from `gen-certs.sh`, not from the gateway's own `generate-certs`, so that the client certificate is ours: `CN=telepi-server`,
  `OU=openshell-user`. Observed: with the client certificate `GetCurrentUser` says `telepi-server`, roles `openshell-user`, provider `mtls`;
  plaintext gRPC is refused (`UNAVAILABLE`); TLS without a client certificate is refused for everything but `Health`
  (`UNAUTHENTICATED: missing authorization header`; `Health` is public by design); sandboxes still start and their supervisors
  call back over `https://127.0.0.1:8080` with a token their sandbox was given, no client certificate involved.
- **The "ordinary user, not operator" part is not enforced in 0.1.3.** The certificate's `OU` values become the caller's roles,
  but roles are only checked when OIDC (with an admin role) is configured; the gateway's own comment says that without OIDC
  every authenticated caller is treated as Platform Admin. Observed: the `openshell-user` certificate can create and delete a
  workspace. So any holder of a certificate signed by this CA has full control. Keep `tls/ca.key` and `tls/client.key` private; only
  the telepi server and the CLI container read the client key.
- Ports 8080 (gRPC) and 8081 (health) are still published on `127.0.0.1` only. Health is plain HTTP.
- **What remains open.** The gateway runs as root with the Docker socket mounted: whoever can call it (now: whoever holds a
  client certificate) can create containers on this Docker daemon, with any bind mount under the two mounted roots, because
  `allow_driver_config` and `enable_bind_mounts` are on (see below). The gateway container sees only the two roots
  (`TELEPI_WORKSPACES`, `TELEPI_REMOTES`) and its own state directory, so a bind source elsewhere on the host is refused
  (`bind source path does not exist`); but anything in those roots is mountable read-write into any sandbox, and bind mounts
  bypass the sandbox's filesystem policy for that path. On a Linux home server a rootless Podman driver would be the safer
  arrangement (the gateway would not hold a root-equivalent socket); **not tried** here.
- State lives in `/var/lib/openshell` inside the OrbStack Linux VM (bind mount, same path on both sides; created by
  Docker, not on the macOS filesystem). It holds the SQLite DB and the sandbox JWT signing keys. It must be a same-path bind
  mount because the gateway extracts the supervisor binary there and the Docker daemon bind-mounts it into sandboxes.
- Bind mounts into sandboxes need `allow_driver_config = true`, `enable_bind_mounts = true` and
  `[openshell.drivers.docker.resource_admission] enabled = false` in `gateway.toml`. Per the docs this lets any API
  caller mount any host path the gateway can see and bypasses filesystem policy for that path. The gateway also checks
  that the bind source exists in its own filesystem, so `TELEPI_WORKSPACES` (and `TELEPI_REMOTES`) are mounted into the gateway container at
  the identical absolute path (`compose.yaml`). A source outside that tree fails with
  `ContainerCreateFailed: bind source path does not exist`.
- Sandboxes are siblings of the gateway: containers `openshell-default--<name>-<uuid>` (network mode `none`,
  `no-new-privileges`, pids limit 2048, AppArmor unconfined) plus a host-networked `...-supervisor` container and two
  named volumes (`openshell-channel-*`, `openshell-supervisor-*`).

## Findings per feature

- **Files in/out.** (a) Bind mount via `--driver-config-json` / `template.driver_config` (above): edits made inside appear on
  the macOS host immediately and a git clone persists there. Files appear owned by the sandbox user (`node`, uid 1000) inside
  and by the macOS user outside (OrbStack maps ownership). The mount target must be listed in the policy's
  `filesystem_policy.read_write`, otherwise Landlock denies it (`ls: cannot open directory '/workspace': Permission denied`).
  Mount target `/sandbox` (the default workdir / `$HOME`) cannot be replaced; use another path such as `/workspace`.
  (b) `sandbox upload` / `sandbox download`: tar over an SSH-session relay; **the CLI shells out to `ssh`**, so the CLI image
  needs `openssh-client` (without it: `failed to inspect upload destination ... No such file or directory (os error 2)`).
  Upload accepted `/workspace/...` and `/tmp/...`; **download only accepts paths under `/sandbox`** (`/tmp/out.txt` was refused:
  `outside the sandbox workspace (/sandbox)`). There is no file read/write RPC in the proto; over gRPC use `ExecSandbox`
  (stdin to `tee`, stdout from `cat`).
- **Egress.** Default deny. Direct connections fail at connect time (`curl: (7) Failed to connect ... Couldn't connect to server`,
  node `EACCES`), not with an HTTP response. For hosts that have an L7 (`protocol: rest`) rule, a denied request gets an
  HTTP 403 with a JSON body (`{"error":"policy_denied","policy":...,"rule":"POST /",...}`).
- **Egress, reads and writes (L7 over HTTPS, verified 2026-10-14).** An endpoint with `protocol: "rest"`, `enforcement: NETWORK_ENFORCEMENT_MODE_ENFORCE`
  and `rules: [{allow: {method, path}}]` makes the supervisor terminate TLS for any host (`issuer: CN=OpenShell Sandbox CA`), read each request and
  allow only matching ones. Works with arbitrary hosts (example.com, github.com, httpbin.org) and on plain HTTP (port 80). A denied request gets
  `403` `{"error":"policy_denied","policy":...,"rule":"POST /foo","layer":"l7","method","path","host","port","binary"}`; the client's connection is
  otherwise fine (curl exits 0, `git push` fails with HTTP 403). Facts:
  - Trust stores: the supervisor sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, `DENO_CERT`
    (all under `/run/openshell-supervisor-ca/material/`) in every process, so curl, git, node (and python) verify without any change.
  - Log line of a denial (via `WatchSandbox` `follow_logs`, ~0.5 s): `HTTP:POST [MED] DENIED POST http://httpbin.org:443/post [policy:NAME engine:l7] [reason:L7_REQUEST deny ...]`.
    The URL always says `http://`; the port is shown for 443 and left out for 80; the query string is not logged; the binary is not on this line (it is on the
    preceding `NET:OPEN ... ALLOWED`). Allowed requests log `HTTP:GET [INFO] ALLOWED ...`. L7 denials create **no** draft chunk.
  - Path globs: `/**` matches every path including `/`; `/**/git-upload-pack` matches `/octocat/Hello-World.git/git-upload-pack`.
  - Rules for the same host:port **merge** into one endpoint, even under a different rule name (adding `POST /post` kept the earlier `GET /**`; adding
    `PUT /put` under another name worked and the log still names the first rule). Adding an L4 rule (no protocol) for a host:port that already has an
    L7 rule did **not** open it: DELETE and POST stayed 403. So send approvals are simply more `UpdateConfig add_rule` calls with the same endpoint.
  - git: with GET, HEAD and `POST /**/git-upload-pack` allowed, `git clone https://github.com/octocat/Hello-World.git` works (`/usr/lib/git-core/git-remote-http`
    is the binary). A push to a host with only these rules reaches `GET info/refs?service=git-receive-pack` (allowed, it is a GET) and the POST to
    `.../git-receive-pack` is the part that is refused.
  - The GitHub provider (`access: FULL`, endpoints github.com/api.github.com) **widens** a host's L7 rules while attached (POST and DELETE went from 403 to 200)
    and the earlier read rule is back after detach (verified with a test provider on httpbin.org).
  - Per binary as before: `node` only reaches the host if `/usr/local/bin/node` is in the rule's binaries.
- **Kernel confinement under OrbStack: active.** Landlock set to `hard_requirement` started fine, and: `ls /opt` is
  `Permission denied` in the sandbox but lists `yarn-v1.22.22` in a plain `node:22-bookworm` container; `/proc/self/status`
  shows `NoNewPrivs: 1, Seccomp: 2, Seccomp_filters: 6, CapEff: 0` versus `NoNewPrivs: 0, Seccomp_filters: 1` in a plain
  container; writes to `/usr` give `EACCES`. (`unshare -U` fails in both, so it proves nothing.)
- **Providers / injection.** Works. The process sees `openshell:resolve:env:v<digits>_ECHO_TOKEN`; the echo server received
  `authorization: Bearer REAL-SECRET-12345`. The same placeholder sent to `example.com` got HTTP 403, and placed in another
  header to the bound endpoint it was also substituted. A private address was **not** refused: the echo container was reached by
  an exact hostname that resolves to a private IP. Two caveats: the sandbox proxy resolves names on the OrbStack VM, not on the
  compose network, so the compose alias did not resolve (`curl: (6) Could not resolve host`); `openshell-echo.orb.local` did
  (that is why `policies/echo-api.yaml` uses it). And the env var holds a placeholder, so something must put the placeholder (not
  a literal `$VAR`) into the request; an exec without a shell does not expand `$ECHO_TOKEN`.
- **Lifecycle.** See the end of this document.

## Driving it from code

### Which client

Recommendation for a Node/TypeScript server: **gRPC directly from Node with the protos pinned to the gateway version**
(`@grpc/grpc-js` + `@grpc/proto-loader`, or generated stubs via `buf`/`ts-proto` from `proto/` at tag `v0.1.3`), wrapped in a thin
adapter. That is what `examples/grpc-client.mjs` does and every call below was verified through it or the CLI.

- `@nvidia/openshell-sdk` (v0.1.0) is the nicest API (`client.sandbox.create/waitReady/exec/delete`, `client.raw` for the rest) but
  **cannot be installed without a GitHub token**: `npm view @nvidia/openshell-sdk --registry=https://npm.pkg.github.com`
  returns `E401 authentication token not provided`, and the package is not on the public npm registry (`404`). It needs a
  GitHub PAT with `read:packages` and an `.npmrc` scope entry. The SDK source is in the repo (`sdk/typescript`), so building it
  yourself is possible (**unverified**). Not installed or tried.
- Shelling out to the CLI container: works (all CLI examples below), costs ~0.3 s per call for `docker compose run`, keeps
  stdout/stderr separate and exits with the remote exit code, but has no structured events and needs `ssh`
  for upload/download. Fine for ops, poor for a server hot path.
- Notes for gRPC: the gateway also serves reflection (not exercised here). With proto-loader, `google.protobuf.Struct` fields
  (`template.driver_config`) need the `{fields:{k:{stringValue:..}}}` wire shape (helper `toStruct` in the example), and proto3
  zero values (exit code 0) are omitted from messages, so default `exit_code ?? 0`.

Fetch the protos matching the gateway (run from this directory; no host install, `curl` is on macOS):

```sh
mkdir -p work/proto && for f in compute_driver credential_driver datamodel extension gateway_interceptor openshell options pagination sandbox supervisor_middleware; do
  curl -fsSL https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.3/proto/$f.proto -o work/proto/$f.proto; done
```

Run the example inside Node on the compose network:

```sh
docker run --rm --network telepi-openshell_default \
  -v $PWD/examples:/app -v $PWD/work/proto:/work/proto:ro -w /app \
  -e MOUNT_SRC=$PWD/work/repo1 node:22-bookworm-slim sh -c 'npm i --silent && node grpc-client.mjs'
```

(`work/repo1` must exist, e.g. a git clone. Observed output of the last run is in the table of timings below.)

From the host, the API is also at `127.0.0.1:8080`, now over mutual TLS, so the telepi server connects there with the client certificate:
`new pkg.openshell.v1.OpenShell('127.0.0.1:8080', grpc.credentials.createSsl(ca, key, cert), {'grpc.ssl_target_name_override': 'localhost', 'grpc.default_authority': 'localhost'})`.
The override is needed because Node refuses to send an IP address as the TLS server name (`Setting the TLS ServerName to an IP address is not permitted`); the certificate carries `localhost` as a name. **Host-side connection works** (`Health` answers in ~40 ms; telepi uses it, configured with `OPENSHELL_TLS_CA/CERT/KEY`).
The examples below were run against the earlier plaintext gateway; add the credentials to run them against this one.

All gRPC calls are on service `openshell.v1.OpenShell`, workspace `default` (`workspace_scope: {workspace: 'default'}`).

### Create a sandbox with a mounted directory

CLI (policy file must be visible to the CLI container, e.g. in `work/`):

```sh
cp policies/dev.yaml work/dev.yaml
os sandbox create --name s1 --from node:22-bookworm --no-tty --detach --policy /work/dev.yaml \
  --driver-config-json '{"docker":{"mounts":[{"type":"bind","source":"/Users/me/.../work/repo1","target":"/workspace","read_only":false}]}}' \
  -- sleep infinity
# -> "Created sandbox: s1" then returns immediately; without --detach the CLI tries to attach and failed with
#    "No such file or directory (os error 2)" (no ssh / no tty) although the sandbox became Ready.
os sandbox list     # NAME CREATED PHASE   ->  s1  2026-10-12 18:29:15  Ready
```

gRPC (`CreateSandbox`, returns immediately; poll `GetSandbox` until `sandbox.status.phase == 'SANDBOX_PHASE_READY'`;
`SANDBOX_PHASE_ERROR` carries reasons in `status.conditions[]`):

```js
await call('CreateSandbox', { workspace_scope: ws, name: 's1', spec: {
  command: ['sleep', 'infinity'],
  template: { image: 'node:22-bookworm',
    driver_config: toStruct({ docker: { mounts: [{ type: 'bind', source: '/abs/path/under/OPENSHELL_WORKSPACES', target: '/workspace', read_only: false }] } }) },
  policy: { version: 1,
    filesystem: { include_workdir: true, read_only: ['/bin','/usr','/lib','/proc','/dev/urandom','/etc','/var/log'], read_write: ['/tmp','/dev/null','/workspace'] },
    landlock: { compatibility: 'hard_requirement' } } } })
const { sandbox } = await call('GetSandbox', { workspace_scope: ws, name: 's1' }) // sandbox.status.phase
```

Image: plain `node:22-bookworm` worked as-is (node v22.23.3, git 2.39.5, curl; runs as `node` uid 1000, `$HOME=/sandbox`, cwd `/sandbox`;
the supervisor is injected, no OpenShell-specific image is needed). Env var `--env KEY=VALUE` exists for non-secrets.
Missing image is pulled by the gateway's Docker driver (`image_pull_policy = if_not_present`).

### Exec with separate stdout / stderr / exit code and a timeout

CLI: `os sandbox exec -n s1 --no-tty --no-login-shell --timeout 2 [--workdir D] [--env K=V] -- <argv...>`. stdout and stderr are
passed through separately and the CLI exit status is the remote exit status (verified: `exit=7` for `process.exit(7)`; timeout
gave `exit=124`). stdin is forwarded (`echo x | os sandbox exec -n s1 --no-tty -- cat`). Note the CLI container prints
compose `Container ... Created` lines on stderr; filter them. argv is exec'd directly (no shell): wrap with `sh -c` yourself if needed.

gRPC `ExecSandbox` (server stream of `{stdout:{data}} | {stderr:{data}} | {exit:{exit_code}}`):

```js
const s = client.ExecSandbox({ workspace_scope: ws, sandbox: 's1', command: ['node','-e','console.log("to-stdout");console.error("to-stderr");process.exit(7)'],
  workdir: '', environment: {}, no_login_shell: true, execution_timeout: { seconds: '2', nanos: 0 }, stdin: Buffer.from('...') })
```
Observed: `{"stdout":"to-stdout\n","stderr":"to-stderr\n","exitCode":7}`; timeout: `{"stdout":"","stderr":"","exitCode":124}` after ~2.0 s.
There is also `ExecSandboxInteractive` (bidi, tty) - **unverified**.

### Read / write a file

- Bind-mounted dir: edit on the host or inside; both see it. Inside, via exec: read `['cat', path]`, write `['tee', path]` with `stdin`
  (verified through gRPC: `stdout: "hello via stdin\n"`, file visible at `work/repo1/written-by-grpc.txt` on the host).
- No file RPC exists. CLI alternative: `os sandbox upload s1 /work/up.txt /workspace/up.txt` (prints `Upload complete`),
  `os sandbox download s1 /sandbox/o.txt /work/dl` (only from under `/sandbox`). Upload is gitignore-filtered inside a git work tree
  (`--no-git-ignore` to disable). `sandbox create --upload <local>[:<sandbox path>]` also exists (**unverified**).

### Delete / stop / start

CLI: `os sandbox delete s1` (`Sandbox s1 deletion accepted; cleanup is pending`, gone within ~4 s), `os sandbox stop s1`, `os sandbox start s1`.
gRPC `DeleteSandbox({workspace_scope, name})` -> `{"outcome":"DELETION_OUTCOME_COMPLETED","sandbox_id":"..."}`; also `StopSandbox`, `StartSandbox`.

### Set policy

Filesystem / Landlock / process settings are **startup-only** (set at create). Network policy is live:

```sh
os policy update s1 --rule-name ex_ro --binary /usr/bin/curl --add-endpoint example.com:443:read-only:rest:enforce --wait
# ✓ Policy version 3 submitted (hash: ...) / ✓ Policy version 3 loaded (active version: 3)
os policy get s1 --full ; os policy list s1     # VERSION HASH STATUS(Loaded|Superseded) CREATED ERROR
os policy set s1 --policy /work/full.yaml       # replace the whole policy (flag shape not exercised)
```
gRPC (verified, telepi uses it): `UpdateConfig({sandbox, merge_operations: [{add_rule: {rule_name, rule: {name, endpoints: [{host, port, ports: [port]}], binaries: [{path}]}}}]})`
adds a rule to a running sandbox without a draft chunk; the response is `{version, policy_hash, ...}`. The sandbox has the rule when
`GetSandboxPolicyStatus({sandbox, version})` reports `active_version >= version` (revision status goes `PENDING` then `LOADED`); a request
made right after that succeeds. Time from `UpdateConfig` to loaded: **1.0 s to 7.6 s** over six runs, depending on where the supervisor's
ten-second poll happens to fall (`OPENSHELL_POLICY_POLL_INTERVAL_SECS` exists in the supervisor, but see "Tuning" below). `ListSandboxPolicies` lists revisions.
Rules are per binary (`binaries`), so `/usr/bin/curl` allowed does not allow `/usr/local/bin/node`. Policy rules apply to the
real executable path; a rule on `/usr/bin/bash` does **not** cover what bash starts (tried: curl stayed denied). The real paths in this
image: `/usr/bin/curl`, `/usr/bin/wget`, `/usr/bin/git`, `/usr/lib/git-core/git-remote-http` (what `git clone https://...` connects with), `/usr/local/bin/node` (also npm).

### Pending network approvals (list and decide)

Every denied connection, in every sandbox and without enabling anything, becomes a **draft policy chunk** (status `pending`), one per
(binary, host:port). They are available through the API, not only the TUI:

CLI:
```sh
os rule get s1 --status pending
#   Chunk: 10079c1b-cf70-4108-9e5d-7e2a176a41a4 / Status: pending / Rule: allow_example_com_443 / Binary: /usr/bin/curl
#   Confidence: 65% / Rationale: Allow curl to connect to example.com:443 (HTTPS). / Prover: prover: no new findings
#   Endpoints: example.com:443 [L4]
os rule approve s1 --chunk-id <id>         # "OK Chunk approved. Policy version: 2, hash: ..."
os rule reject  s1 --chunk-id <id> --reason "not needed"   # "OK Chunk rejected."
os rule history s1 ; os rule approve-all s1 ; os rule clear s1
```

gRPC (verified): `GetDraftPolicy({workspace_scope, sandbox, status_filter:'pending'})` ->
`{chunks:[{id, status:'pending', rule_name, binary, rationale, security_notes, confidence, proposed_rule:{endpoints:[{host,port,...}]}, review_token, hit_count, validation_result, ...}], draft_version, rolling_summary}`;
`ApproveDraftChunk({sandbox, chunk_id, review_token})` -> `{policy_version, policy_hash}`; `RejectDraftChunk({sandbox, chunk_id, reason})`;
also `ApproveAllDraftChunks`, `EditDraftChunk`, `UndoDraftChunk`, `ClearDraftChunks`, `GetDraftHistory`.
Push: `WatchSandbox({sandbox, follow_status, follow_logs, follow_events})` streams `SandboxStreamEvent`. The `DraftPolicyUpdate`
variant never arrived in 0.1.3 (tried with all three follow flags; a chunk appeared in `GetDraftPolicy` about 5 s after the
denial and no event came). **`follow_logs: true` is what works**: the supervisor's log lines arrive about half a second after they
happen, and a denial is one of them: `NET:OPEN [MED] DENIED /usr/bin/curl(0) -> example.edu:443 [reason:transparent_tcp_policy_denied]`
(binary, host, port), followed by `NET:REFUSE ... DENIED example.edu [reason:policy_dns_ineligible]` and, for the synthetic address the
supervisor hands out (`198.18.x.x`), duplicates with `reason:transparent_tcp_mapping_denied`. Without `since_time` the stream first
replays the sandbox's recent log; telepi passes `since_time` and `log_sources: ["sandbox"]`. `GetSandboxLogs` returns the same lines.
Failure signatures seen from inside the sandbox: curl exit 7 `Failed to connect to X port N ... Couldn't connect to server`; wget exit 4
(quiet with `-q`); node `fetch failed` / `connect EACCES 198.18.0.x:443`; git `Failed to connect to ...`; npm `errno EACCES` `syscall connect`.
There is also an opt-in policy advisor (`agent_policy_proposals_enabled`) where the in-sandbox agent submits its own proposals with a
reason (docs only, **unverified**), and `--approval-mode auto` (auto-approves chunks with no prover findings; default `manual`).

Latencies observed (spike): denied `curl` -> chunk visible to `GetDraftPolicy` after **~8 s** (the supervisor flushes denials in batches,
`OPENSHELL_DENIAL_FLUSH_INTERVAL_SECS`, default 10); `ApproveDraftChunk` -> allowed request succeeds after **up to ~10 s** (the supervisor's policy poll).
The log stream (above) is the way around the first delay; for the second there is only waiting for `active_version`.

**Tuning: not possible.** Both intervals are read from the supervisor's own environment (`OPENSHELL_DENIAL_FLUSH_INTERVAL_SECS`,
`OPENSHELL_POLICY_POLL_INTERVAL_SECS`, in the source at v0.1.3). The gateway does not pass anything of its own environment on, the Docker
driver builds the supervisor container's environment itself, and `CreateSandbox` refuses the names:
`spec.environment keys starting with OPENSHELL_ are reserved`. There is no key for them in `gateway.toml`. (Stopping and starting a sandbox
loads the current policy at startup in under a second, which would also work as a way to apply a rule at once, but it ends every process
in the sandbox, so telepi does not use it for approvals.)

### Create a provider and attach it

```sh
os profile lint   -f /work/echo-api.yaml          # Provider profile lint passed.
os profile import -f /work/echo-api.yaml --global # Imported 1 provider profile.   (gateway ships NO profiles; import first)
os provider create --name echo-prov --type echo-api --credential ECHO_TOKEN=REAL-SECRET-12345   # ✓ Created provider echo-prov
os sandbox provider attach s1 echo-prov --wait    # echo-prov: ready; Installed: credentials=true, policy=true  (works on a running sandbox)
os sandbox exec -n s1 --no-tty -- printenv ECHO_TOKEN     # openshell:resolve:env:v1939528548855173087_ECHO_TOKEN
os sandbox exec -n s1 --no-tty -- curl -H "Authorization: Bearer openshell:resolve:env:v..._ECHO_TOKEN" http://openshell-echo.orb.local:9000/hello
# echo server saw:  "authorization":"Bearer REAL-SECRET-12345"
```
`--type` must be an imported profile (docs say unknown types are rejected; **unverified**). The profile's `endpoints` bound the credential
and its `binaries` decide which executable may use it (here `/usr/bin/curl`); the endpoint also gets network access via the attached
provider. gRPC: `CreateProvider({provider:{metadata:{name},type,credentials:{ECHO_TOKEN:'...'}}})`, `AttachSandboxProvider({sandbox,provider})`
(**not exercised over gRPC**; profile import is `ImportProviderProfiles`, also not exercised). Detach: `os sandbox provider detach s1 echo-prov`.
`os provider update` / `refresh` exist for rotation (unverified). Delete: `os provider delete`, `os profile delete echo-api --global`.

### Timings (OrbStack, image already pulled, warm)

| Operation | Observed |
|---|---|
| `CreateSandbox` call returns | ~0.03 s |
| Create -> phase READY (gRPC poll, 200 ms) | ~0.65 s (CLI create+poll incl. compose run overhead: ~1.1 s) |
| One `ExecSandbox` round trip (`node -e ...`, gRPC) | ~20-40 ms |
| One exec via `docker compose run cli` | ~0.28 s (almost all compose overhead) |
| `DeleteSandbox` | completes within the call (gRPC); containers/volumes gone ~4 s later |
| Denial -> pending chunk visible | ~8 s |
| Approval -> egress allowed | ~10 s |
| First pull of the three images + `node:22-bookworm` | not measured |

## Using it from telepi

`TELEPI_RUNTIME=pi` (see the root README, "Real agent"). The telepi client lives in `apps/server/src/runtime/pi/openshell/`
with the v0.1.3 protos vendored in `openshell/proto/` (only the four that `openshell.proto` needs).

**Paths.** The gateway can bind only paths that exist at the same absolute path inside its own container, so `compose.yaml` mounts
two host paths from `.env`, each at the same path: `TELEPI_WORKSPACES` (the server clones task workspaces under it; give the
server the same `TELEPI_WORKSPACES`) and `TELEPI_REMOTES` (a directory or a single bare repo; project remotes that are local
paths must be inside it so `git push` works from the sandbox; give the server the same `TELEPI_REMOTES` to get a clear error
for a project outside it). The gateway can bind-mount anything under those two paths into any sandbox, so keep them narrow.
`docker compose up -d` after editing `.env`.

**Observed with the telepi runtime (differences from the spike notes above)**

- Sandbox names are limited to **19 characters** (`name exceeds maximum length (28 > 19)`); telepi uses `t-<16 chars of the task id>`.
  Labels (`telepi=1`) work and `ListSandboxes` filters on them, which is how strays are found after a crash.
- **Exec does not kill anything.** `execution_timeout` returns exit 124 on time but the process keeps running, and cancelling
  the gRPC stream does not kill it either. A second exec cannot signal it (`kill: Operation not permitted`: every exec gets its own
  Landlock domain), and `kill` on a process group (`kill -- -PID`) is refused inside the sandbox (seccomp), while `kill PID`
  works for processes in the same exec. telepi wraps each command in a bash watchdog (same exec) that polls for a kill file in
  `/tmp/.telepi/`, then does `SIGSTOP` + `SIGKILL` on the command and all its descendants; a timeout or abort creates the file
  through a second exec. Verified: timeout and abort end the command and a backgrounded subshell, within ~0.2 s. Processes that
  already detached (parent exited) are out of reach of the watchdog, and another exec cannot read their environment either
  (`/proc/<pid>/environ`: `Permission denied`), so no marker variable can find them. After a timeout or abort telepi lists, in a new exec,
  the live processes younger than the command (`ps -o etimes`); if there is one it stops and starts the sandbox (0.7 s measured) and
  tells the model in the tool result. Verified with `(setsid sleep 300 &); sleep 100` and a 3 s timeout.
- **File tools run in the sandbox.** `read`, `write` and `edit` are implemented as `cat`, `tee`-style `cat >`, `find`, `mkdir`, `mv` and friends
  through `ExecSandbox` (`apps/server/src/runtime/pi/openshell/files.ts`), so Landlock applies. A request over 1 MiB is refused by the gateway
  (`decoded message length too large`), so writes go in pieces of 512 KiB (20 MB: 0.5 s). Line ranges of big files are scanned by streaming `cat`
  (20 MB, 200000 lines: 0.17 s). Observed errors: a read outside the workspace gives `cat: /opt/yarn-v1.22.22/package.json: Permission denied`
  (the same path is readable in a plain container), a write to `/usr` gives `Permission denied`.
- **Network approvals no longer wait for draft chunks.** telepi follows the supervisor's log stream (`WatchSandbox` with `follow_logs`)
  and opens the card about one second after a command that was refused has ended (it groups requests that arrive within 1.2 s);
  commands that plainly target a host are asked about before they run. Approval adds a rule with `UpdateConfig` and waits for
  `GetSandboxPolicyStatus.active_version`. The draft chunks are only polled as a second source and are rejected, never approved.
  Observed in `TELEPI_RUNTIME=pi` runs: card for an obvious command 0.3 s after the model issued it (nothing ran); card for a
  `node -e fetch(...)` 1.0 s after it failed; approval to loaded policy 1.0 s, 4 s and 7.5 s (three runs), after which the first
  attempt of the command worked. See the root README for the rest.
- **Provider profiles are scoped.** `ImportProviderProfiles` without `workspace_scope` imports a platform (global) profile, as
  `profile import --global`; with a workspace scope, `CreateProvider` cannot see it (`provider profile 'x' was not found in the
  requested scope`). Over gRPC the enums are strings (`PROVIDER_PROFILE_CATEGORY_OTHER`, `NETWORK_ACCESS_PRESET_FULL`,
  `NETWORK_ENFORCEMENT_MODE_ENFORCE`).
- **Providers can be detached at runtime, over gRPC.** `AttachSandboxProvider` returns a receipt; `GetSandboxProviderStatus` with
  `receipt_id` goes `PENDING / SNAPSHOT_MISMATCH` then `READY` after ~10 s (placeholder env var and the endpoint's network access
  appear). `DetachSandboxProvider` goes `PENDING` then `REVOKED` after ~10 s; until then the credential still works. After that
  the env var is gone and the endpoint is denied again. telepi waits for both states.
- Sandboxes survive a `kill -9` of the telepi server (the gateway keeps them); telepi deletes all `telepi=1` sandboxes on start and
  recreates the one of each resumed task.
- Files the agent writes appear on the host owned by the macOS user, git commits made inside work with identity set through
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` environment variables, and `git push` to a bare repo owned by the macOS user works from inside.

## Lifecycle (verified)

- `sandbox stop` keeps the workspace and bind-mounted files (phase `Stopped`, container `Exited`); `sandbox start` brings it back Ready.
  Verified with the telepi runtime: stop plus start plus ready takes **0.6 to 0.8 s**; every process is gone (including a `setsid`
  one that no exec could signal); a file written to `/tmp` survived, so did the environment of the sandbox spec, bind-mounted files, and
  the network policy with the rules approved so far (a request to a host approved earlier worked right after the restart). Attached providers
  are part of the sandbox record and were not checked after a restart. telepi uses this to end a command that left a process behind.
- `sandbox delete` removes the sandbox record, both containers and both named volumes (`docker ps -a | grep openshell-default` and
  `docker volume ls | grep openshell` empty afterwards). Bind-mounted host files remain.
- `docker compose restart gateway`: sandboxes (still Ready and execable), policies and revisions (v1..v3 intact), provider records,
  imported profiles and attachments (placeholder env still present, `echo-prov` still listed) all survived; network allow rules kept working.
  This is because state is in SQLite on the persistent `/var/lib/openshell` bind mount. Wiping that directory loses everything and
  orphans sandbox containers.

## Known rough edges

- `docker compose run cli sandbox create ...` without `--detach` and a command: ends with an `os error 2` after the sandbox is Ready (CLI wants an attach/ssh path).
- Gateway logs show harmless `concurrent modification detected during sandbox reconciliation` warnings at create/delete.
- The `.env` paths are absolute and machine specific (`.env.example` has placeholders); edit `TELEPI_WORKSPACES` and `TELEPI_REMOTES` for another checkout.
- Not tried: OIDC auth, a rootless Podman driver, GPU, the Python/Go/Rust SDKs, VM/Podman drivers, `ExecSandboxInteractive`, port forwarding/services, gateway reflection,
  `x86_64` images (OrbStack here is arm64; the images are published multi-arch).
