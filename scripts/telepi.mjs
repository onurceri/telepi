#!/usr/bin/env node
// telepi CLI: set up, start, stop and pair a telepi install from a checkout. Plain Node, no build step.
//   pnpm telepi setup | doctor | start | stop | restart | status | pair [--tailscale] | project add <path-or-git-url> | uninstall [--yes]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GW_DIR = path.join(REPO, "deploy", "openshell");
const TLS_DIR = path.join(GW_DIR, "tls");
const HOME = path.resolve(process.env.TELEPI_HOME || path.join(os.homedir(), ".telepi"));
const CONFIG = path.join(HOME, "config.json");
const PIDFILE = path.join(HOME, "server.pid");
const LOGFILE = path.join(HOME, "server.log");
const GW_ENV = path.join(HOME, "gateway.env");
const GATEWAY = "openshell-gateway";
const COMPOSE_PROJECT = "telepi-openshell";
// Containers and volumes the gateway makes for sandboxes carry this label.
const SANDBOX_LABEL = `openshell.ai/sandbox-namespace=${COMPOSE_PROJECT}`;
// The gateway's own data, a host path inside Docker's VM (see compose.yaml).
const GW_DATA = "/var/lib/openshell";
// Every image telepi makes Docker pull or build: the gateway, what it pulls for sandboxes, and the sandbox image itself.
const SANDBOX_IMAGE = "node:22-bookworm";
const IMAGES = ["ghcr.io/nvidia/openshell/gateway:0.1.3", "ghcr.io/nvidia/openshell/supervisor:0.1.3", "ghcr.io/nvidia/openshell/sandbox:0.1.3", "telepi-openshell-cli:0.1.3", SANDBOX_IMAGE];

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const opts = (n) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));

const say = (s = "") => console.log(s);
const ok = (s) => say(`  ok    ${s}`);
const bad = (s, fix) => { say(`  FAIL  ${s}`); if (fix) say(`        -> ${fix}`); };
const die = (s) => { console.error(`\ntelepi: ${s}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A hung Docker daemon must not hang telepi: every probe gives up after 20 s.
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: "utf8", timeout: 20000, ...o });
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };

// --- config -----------------------------------------------------------------

function loadCfg() {
  const c = readJson(CONFIG, {});
  return {
    port: c.port ?? 8787,
    publicUrl: c.publicUrl ?? null,
    workspaces: c.workspaces ?? path.join(HOME, "workspaces"),
    remotes: c.remotes ?? path.join(HOME, "remotes"),
    dataDir: c.dataDir ?? path.join(HOME, "data"),
    piDir: c.piDir ?? null,
  };
}
function saveCfg(c) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}
const piDirOf = (cfg) => path.resolve(process.env.TELEPI_PI_DIR || cfg.piDir || path.join(os.homedir(), ".pi", "agent"));

// The environment the server runs with. <home>/env holds optional extra KEY=VALUE lines (for example TELEPI_GITHUB_TOKEN).
function serverEnv(cfg) {
  const extra = {};
  try {
    for (const line of fs.readFileSync(path.join(HOME, "env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#")) extra[m[1]] = m[2];
    }
  } catch {}
  const env = {
    ...process.env, ...extra,
    TELEPI_RUNTIME: "pi", TELEPI_PORT: String(cfg.port), TELEPI_DATA_DIR: cfg.dataDir,
    TELEPI_WORKSPACES: cfg.workspaces, TELEPI_REMOTES: cfg.remotes, TELEPI_PI_DIR: piDirOf(cfg),
    OPENSHELL_TLS_CA: path.join(TLS_DIR, "ca.crt"), OPENSHELL_TLS_CERT: path.join(TLS_DIR, "client.crt"), OPENSHELL_TLS_KEY: path.join(TLS_DIR, "client.key"),
  };
  if (cfg.publicUrl) env.TELEPI_PUBLIC_URL = cfg.publicUrl; else delete env.TELEPI_PUBLIC_URL;
  delete env.TELEPI_PAIR;
  return env;
}

// --- probes -----------------------------------------------------------------

function dockerUp() { const r = run("docker", ["info", "--format", "{{.ServerVersion}}"]); return r.status === 0 ? r.stdout.trim() : null; }
function gatewayHealthy() {
  return fetch("http://127.0.0.1:8081/readyz", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}
function gatewayMtls() {
  return new Promise((resolve) => {
    try {
      const s = tls.connect({ host: "127.0.0.1", port: 8080, servername: "localhost", ca: fs.readFileSync(path.join(TLS_DIR, "ca.crt")),
        cert: fs.readFileSync(path.join(TLS_DIR, "client.crt")), key: fs.readFileSync(path.join(TLS_DIR, "client.key")), ALPNProtocols: ["h2"] });
      s.setTimeout(3000, () => { s.destroy(); resolve(false); });
      s.on("secureConnect", () => { s.end(); resolve(true); });
      s.on("error", () => resolve(false));
    } catch { resolve(false); }
  });
}
function serverPid() {
  let pid; try { pid = Number(fs.readFileSync(PIDFILE, "utf8")); } catch { return null; }
  if (!pid) return null;
  const r = run("ps", ["-p", String(pid), "-o", "command="]);
  return r.status === 0 && r.stdout.includes("src/index.ts") ? pid : null;
}
/** Who listens on the port: its pid, and whether it is a telepi server from this checkout (found even when its pid file is gone). */
function portOwner(port) {
  const pid = Number(run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout?.trim().split("\n")[0]);
  if (!pid) return null;
  const command = run("ps", ["-p", String(pid), "-o", "command="]).stdout?.trim() ?? "";
  const cwd = (run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).stdout ?? "").split("\n").find((l) => l.startsWith("n"))?.slice(1);
  return { pid, command, telepi: command.includes("src/index.ts") && cwd === path.join(REPO, "apps", "server") };
}
async function killAndWait(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  // The server removes its sandboxes on the way out: give it up to 30 s before forcing it.
  for (let i = 0; i < 60; i++) { try { process.kill(pid, 0); } catch { return; } await sleep(500); }
  try { process.kill(pid, "SIGKILL"); } catch {}
}
async function serverUp(cfg) {
  try { const r = await fetch(`http://127.0.0.1:${cfg.port}/api/session`, { signal: AbortSignal.timeout(2000) }); return r.status === 401 || r.ok; } catch { return false; }
}
function piLogin(cfg) {
  const file = path.join(piDirOf(cfg), "auth.json");
  const j = readJson(file, null);
  if (!fs.existsSync(file)) return { found: false, file, providers: [] };
  return { found: true, file, providers: j && typeof j === "object" ? Object.keys(j) : [] };
}
function piModel(cfg) {
  if (process.env.TELEPI_MODEL) return process.env.TELEPI_MODEL;
  const s = readJson(path.join(piDirOf(cfg), "settings.json"), {});
  return s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : null;
}
const urlOf = (cfg) => cfg.publicUrl ?? `http://127.0.0.1:${cfg.port}`;

// --- checks -----------------------------------------------------------------

/** Collects check results. A FAIL blocks setup; a "warn" is worth knowing but telepi works. */
class Report {
  fails = 0;
  warns = 0;
  check(pass, good, problem, fix) { if (pass) ok(good); else { this.fails++; bad(problem, fix); } return pass; }
  warn(problem, fix) { this.warns++; say(`  warn  ${problem}`); if (fix) say(`        -> ${fix}`); }
}

const has = (cmd) => !run(cmd, ["--version"]).error;
const MAC = process.platform === "darwin";
const linuxInstall = (pkgs) =>
  has("apt-get") ? `sudo apt-get install -y ${pkgs.apt}` : has("dnf") ? `sudo dnf install -y ${pkgs.dnf}` : has("pacman") ? `sudo pacman -S ${pkgs.pacman}` : `install ${pkgs.apt} with your package manager`;
/** The exact command that installs a missing tool on this machine. */
const FIX = {
  node: () => MAC && has("brew") ? "`brew install node`, or with nvm: `nvm install 22`" : "with nvm: `nvm install 22` (https://github.com/nvm-sh/nvm), or the installer at https://nodejs.org",
  pnpm: () => "`corepack enable pnpm` (corepack ships with Node), or `npm install -g pnpm`",
  git: () => MAC ? "`xcode-select --install`" + (has("brew") ? ", or `brew install git`" : "") : `\`${linuxInstall({ apt: "git", dnf: "git", pacman: "git" })}\``,
  docker: () => MAC ? (has("brew") ? "`brew install --cask orbstack` (or Docker Desktop), then open it once" : "install OrbStack (https://orbstack.dev) or Docker Desktop, then open it once")
    : "`curl -fsSL https://get.docker.com | sh`, then `sudo usermod -aG docker $USER` and log in again",
  dockerStart: () => MAC ? "open OrbStack or Docker Desktop (menu bar) and wait until it says running" : "`sudo systemctl start docker`",
  compose: () => MAC ? "update Docker Desktop or OrbStack (both include `docker compose`)" : `\`${linuxInstall({ apt: "docker-compose-plugin", dnf: "docker-compose-plugin", pacman: "docker-compose" })}\``,
  pi: () => (has("pi") ? "" : "install Pi with `npm install -g @earendil-works/pi-coding-agent`, then ") + "run `pi`, type `/login` and pick a provider",
};

/** What must be on the machine before telepi can be set up. Shared by setup and doctor. */
function machineChecks(cfg, r) {
  const major = Number(process.versions.node.split(".")[0]);
  r.check(major >= 22, `Node ${process.versions.node}`, `Node ${process.versions.node} is too old (22 or newer needed)`, FIX.node());
  const pn = run("pnpm", ["-v"]);
  r.check(pn.status === 0, `pnpm ${pn.stdout?.trim()}`, "pnpm is not installed", FIX.pnpm());
  const gv = run("git", ["--version"]);
  r.check(gv.status === 0, gv.stdout?.trim(), "git is not installed", FIX.git());
  if (!has("docker")) r.check(false, "", "Docker is not installed", FIX.docker());
  else {
    const dv = dockerUp();
    if (r.check(!!dv, `Docker is running (server ${dv})`, "Docker is installed but not answering", FIX.dockerStart())) {
      const cv = run("docker", ["compose", "version", "--short"]);
      r.check(cv.status === 0, `docker compose ${cv.stdout?.trim()}`, "`docker compose` is missing", FIX.compose());
    }
  }
  const pi = piLogin(cfg);
  r.check(pi.found && pi.providers.length > 0, `Pi login found (${pi.providers.join(", ")})`,
    pi.found ? `Pi's auth.json at ${pi.file} has no provider in it` : `No Pi login found (looked for ${pi.file})`, FIX.pi());
}

// --- doctor -----------------------------------------------------------------

/** Checks everything setup and start depend on, and the phone side. Changes nothing. */
async function doctor() {
  const cfg = loadCfg();
  if (process.env.TELEPI_PI_DIR) cfg.piDir = path.resolve(process.env.TELEPI_PI_DIR);
  const r = new Report();
  say(`telepi doctor  (home: ${HOME})\n\nThis machine`);
  machineChecks(cfg, r);
  if (!has("pi")) r.warn("the `pi` command is not installed", "not needed to run telepi, but it is how you log in and pick a model: `npm install -g @earendil-works/pi-coding-agent`");

  say("\ntelepi");
  if (!r.check(fs.existsSync(CONFIG), `set up (${CONFIG})`, "telepi is not set up on this machine", "`pnpm telepi setup`")) return doctorEnd(r);
  for (const [what, dir] of [["data folder", cfg.dataDir], ["workspaces folder", cfg.workspaces], ["remotes folder", cfg.remotes]])
    r.check(fs.existsSync(dir), `${what} ${dir}`, `${what} ${dir} is missing`, "`pnpm telepi setup` makes it");
  r.check(["ca.crt", "client.crt", "client.key"].every((f) => fs.existsSync(path.join(TLS_DIR, f))), "gateway certificates", "gateway certificates are missing", "`pnpm telepi setup` makes them");

  say("\nGateway (OpenShell)");
  const exists = run("docker", ["inspect", GATEWAY, "--format", "{{.State.Running}}"]);
  if (!r.check(exists.status === 0, `container ${GATEWAY} exists`, `container ${GATEWAY} does not exist`, "`pnpm telepi setup` creates it")) {}
  else if (r.check(exists.stdout.trim() === "true", "container is running", "container is stopped", `\`docker start ${GATEWAY}\` or \`pnpm telepi setup\``)) {
    const mounts = gatewayMounts() ?? [];
    r.check([cfg.workspaces, cfg.remotes].every((d) => mounts.includes(`${d}=>${d}`)), "container mounts telepi's workspaces and remotes folders",
      "container was made for other folders, so sandboxes cannot see this install's workspaces", "`pnpm telepi setup` recreates it (running sandboxes end)");
    r.check(await gatewayHealthy(), "health check answers", "health check does not answer", `see \`docker logs ${GATEWAY}\``);
    r.check(await gatewayMtls(), "mutual TLS works with telepi's client certificate", "mutual TLS fails", "the certificates do not match the running gateway: `pnpm telepi setup` (keeps them) then `docker restart " + GATEWAY + "`");
  }

  say("\nServer");
  const dist = path.join(REPO, "apps", "web", "dist", "index.html");
  r.check(fs.existsSync(dist), "web app is built", "web app is not built", "`pnpm telepi setup` builds it, or `pnpm --filter @telepi/web build`");
  const pid = serverPid();
  if (pid) { if (r.check(await serverUp(cfg), `running (pid ${pid}) and answering on port ${cfg.port}`, `running (pid ${pid}) but not answering on port ${cfg.port}`, `see ${LOGFILE}, then \`pnpm telepi restart\``)) await checkModel(cfg, r); }
  else {
    const busy = run("lsof", ["-ti", `tcp:${cfg.port}`, "-sTCP:LISTEN"]).stdout?.trim();
    if (busy) r.check(false, "", `not running, and port ${cfg.port} is taken by another program (pid ${busy.split("\n")[0]})`, `stop that program, or run setup with --port <another port>`);
    else r.warn("not running", "`pnpm telepi start`");
    const tail = tailLog(3);
    if (tail && /error|fail/i.test(tail)) say(`        last log lines:\n${tail.replace(/^/gm, "          ")}`);
  }
  const projects = readJson(path.join(cfg.dataDir, "projects.json"), []);
  if (!projects.length) r.warn("no projects yet", "`pnpm telepi project add <path-or-git-url>`");
  for (const p of projects) {
    if (!r.check(fs.existsSync(p.repoPath), `project ${p.id} (${p.repoPath})`, `project ${p.id}: ${p.repoPath} no longer exists`, `move it back, or add it again with \`pnpm telepi project add\``)) continue;
    if (run("git", ["-C", p.repoPath, "remote", "get-url", "origin"]).status !== 0) r.warn(`project ${p.id} has no origin remote`, "telepi pushes work back to origin: `git remote add origin <url>`");
  }

  say("\nPhone");
  if (cfg.publicUrl) r.check(cfg.publicUrl.startsWith("https://"), `reachable at ${cfg.publicUrl}`, `${cfg.publicUrl} is not HTTPS`, "the phone needs HTTPS to install the app and get notifications");
  else {
    const ts = tailscale();
    r.warn("no HTTPS address yet, so the app only opens on this machine",
      ts.state === "ok" ? "Tailscale is ready: `pnpm telepi pair --tailscale`" : ts.state === "missing" ? "install Tailscale on this machine and your phone, then `pnpm telepi pair --tailscale`" : "log in to Tailscale (`tailscale up`), then `pnpm telepi pair --tailscale`");
  }
  doctorEnd(r);
}

function doctorEnd(r) {
  say("");
  if (r.fails) die(`${r.fails} problem${r.fails > 1 ? "s" : ""}${r.warns ? ` and ${r.warns} warning${r.warns > 1 ? "s" : ""}` : ""}. Each has its fix above.`);
  say(r.warns ? `No problems. ${r.warns} warning${r.warns > 1 ? "s" : ""} above.` : "Everything looks right.");
}

// --- setup ------------------------------------------------------------------

async function setup() {
  const cfg = loadCfg();
  if (opt("port")) cfg.port = Number(opt("port"));
  if (opt("workspaces")) cfg.workspaces = path.resolve(opt("workspaces"));
  if (opt("remotes")) cfg.remotes = path.resolve(opt("remotes"));
  if (process.env.TELEPI_PI_DIR) cfg.piDir = path.resolve(process.env.TELEPI_PI_DIR);
  say(`telepi setup  (home: ${HOME})\n\nChecking this machine`);
  const r = new Report();
  machineChecks(cfg, r);
  if (r.fails) die(`${r.fails} thing${r.fails > 1 ? "s" : ""} to fix above, so setup stopped here. Nothing was changed.\nFix them and run \`pnpm telepi setup\` again, or \`pnpm telepi doctor\` to check everything.`);

  say("\nPreparing the telepi home");
  for (const d of [HOME, cfg.dataDir, cfg.workspaces, cfg.remotes, path.join(HOME, "repos")]) fs.mkdirSync(d, { recursive: true });
  saveCfg(cfg);
  ok(`config ${CONFIG}`);
  fs.writeFileSync(GW_ENV, `# written by telepi setup; same-path mounts for the OpenShell gateway\nTELEPI_WORKSPACES=${cfg.workspaces}\nTELEPI_REMOTES=${cfg.remotes}\n`);
  const devEnv = path.join(GW_DIR, ".env");
  if (!fs.existsSync(devEnv)) { fs.copyFileSync(GW_ENV, devEnv); ok("deploy/openshell/.env created"); }
  else ok("deploy/openshell/.env already exists, left as it is (setup uses its own gateway.env)");
  const pj = path.join(cfg.dataDir, "projects.json");
  if (!fs.existsSync(pj)) { fs.writeFileSync(pj, "[]", { mode: 0o600 }); ok("empty project list (add one with `pnpm telepi project add <path-or-git-url>`)"); }

  say("\nGateway (OpenShell, in Docker)");
  const cert = run("sh", [path.join(GW_DIR, "gen-certs.sh")], { encoding: "utf8" });
  if (cert.status !== 0) die(`could not make the gateway certificates:\n${cert.stderr || cert.stdout}`);
  ok(cert.stdout.includes("keeping") ? "certificates already there" : "certificates made");
  await ensureGateway(cfg);

  say("\nWeb app");
  buildWeb();

  for (const p of opts("project")) await projectAdd(p, cfg);

  say("\nStarting telepi");
  await start(cfg);
  await checkModel(cfg, new Report());
  say("\nReady. On your phone:");
  await pair(cfg);
}

function gatewayMounts() {
  const r = run("docker", ["inspect", GATEWAY, "--format", "{{json .Mounts}}"]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).map((m) => `${m.Source}=>${m.Destination}`); } catch { return null; }
}
async function ensureGateway(cfg) {
  const mounts = gatewayMounts();
  const want = [`${cfg.workspaces}=>${cfg.workspaces}`, `${cfg.remotes}=>${cfg.remotes}`];
  const present = mounts && want.every((w) => mounts.includes(w)) && mounts.some((m) => m.endsWith(`=>/etc/openshell/tls`) && m.startsWith(TLS_DIR));
  if (present) {
    if (run("docker", ["inspect", GATEWAY, "--format", "{{.State.Running}}"]).stdout.trim() !== "true") run("docker", ["start", GATEWAY]);
    ok("gateway container already has the right mounts, not recreated");
  } else {
    say(mounts ? "  ..    gateway exists with different folders: recreating it (running sandboxes end)" : "  ..    pulling images and starting the gateway (first time takes a few minutes)");
    const r = spawnSync("docker", ["compose", "--env-file", GW_ENV, "up", "-d", "gateway"], { cwd: GW_DIR, stdio: "inherit" });
    if (r.status !== 0) die("`docker compose up` failed (see above). Check that Docker can pull images, then run setup again.");
  }
  for (let i = 0; i < 60; i++) { if ((await gatewayHealthy()) && (await gatewayMtls())) { ok("gateway healthy (health check and mutual TLS answer)"); return; } await sleep(1000); }
  die(`the gateway did not become healthy in 60 s. See \`docker logs ${GATEWAY}\`.`);
}

function buildWeb() {
  const dist = path.join(REPO, "apps", "web", "dist", "index.html");
  const newest = (d) => { let t = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (["node_modules", "dist"].includes(e.name)) continue; const p = path.join(d, e.name); t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs); } return t; };
  const web = path.join(REPO, "apps", "web");
  if (fs.existsSync(dist) && fs.statSync(dist).mtimeMs >= newest(web)) return ok("web app already built");
  const r = spawnSync("pnpm", ["--filter", "@telepi/web", "build"], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) die("the web app did not build (see above). Did `pnpm install` finish?");
  ok("web app built");
}

// --- start / stop / status --------------------------------------------------

async function start(cfg = loadCfg()) {
  if (!fs.existsSync(CONFIG)) die("not set up yet. Run `pnpm telepi setup` first.");
  if (serverPid()) { ok(`server already running (pid ${serverPid()})`); return; }
  if (!(await gatewayMtls())) {
    if (!dockerUp()) die("Docker is not running. Start Docker (Docker Desktop, OrbStack or the docker service), then `pnpm telepi start` again.");
    await ensureGateway(cfg);
  }
  const owner = portOwner(cfg.port);
  if (owner?.telepi) { say(`  ..    an older telepi server (pid ${owner.pid}) still holds port ${cfg.port}; stopping it`); await killAndWait(owner.pid); }
  else if (owner) die(`port ${cfg.port} is used by another program (pid ${owner.pid}: ${owner.command.slice(0, 80)}).\nStop it, or run \`pnpm telepi setup --port <another port>\`.`);
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(LOGFILE, "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: path.join(REPO, "apps", "server"), env: serverEnv(cfg), detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  for (let i = 0; i < 60; i++) {
    if (!serverPid()) die(`the server stopped right after starting. Last log lines:\n${tailLog(8)}`);
    // Only our own process counts as up: something else answering on the port is not this server.
    if ((await serverUp(cfg)) && portOwner(cfg.port)?.pid === child.pid) { ok(`server running (pid ${child.pid}) at ${urlOf(cfg)}, log ${LOGFILE}`); return; }
    await sleep(1000);
  }
  die(`the server did not answer in 60 s. See ${LOGFILE}`);
}
const tailLog = (n) => { try { return fs.readFileSync(LOGFILE, "utf8").trim().split("\n").slice(-n).join("\n"); } catch { return ""; } };

/** Stops the server and, unless only the server is restarting, the gateway too: afterwards nothing of telepi runs. */
async function stop({ gateway = true } = {}) {
  const cfg = loadCfg();
  const pid = serverPid() ?? (portOwner(cfg.port)?.telepi ? portOwner(cfg.port).pid : null);
  if (pid) {
    say(`  ..    stopping the server (pid ${pid}); it removes its sandboxes first`);
    await killAndWait(pid);
    ok("server stopped");
  } else ok("server was not running");
  try { fs.unlinkSync(PIDFILE); } catch {}
  if (!gateway) return;
  if (!dockerUp()) return ok("Docker is not running, so neither is the gateway");
  // Sandboxes the server could not remove (it crashed, or was killed): stopped here, removed by the gateway on the next start.
  const left = dockerIds("ps", "-q", "--filter", `label=${SANDBOX_LABEL}`);
  if (left.length) { run("docker", ["stop", ...left], { timeout: 60000 }); ok(`stopped ${left.length} leftover sandbox container${left.length > 1 ? "s" : ""}`); }
  if (run("docker", ["inspect", GATEWAY, "--format", "{{.State.Running}}"]).stdout?.trim() === "true") {
    run("docker", ["stop", GATEWAY], { timeout: 60000 });
    ok("gateway stopped (it stays stopped after a reboot)");
  } else ok("gateway was not running");
  say("\nNothing of telepi is running now. `pnpm telepi start` starts it again.");
}
const dockerIds = (...a) => (run("docker", a).stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

async function status() {
  const cfg = loadCfg();
  const gw = (await gatewayHealthy()) && (await gatewayMtls());
  const pid = serverPid(), up = pid ? await serverUp(cfg) : false;
  const pi = piLogin(cfg);
  say(`home      ${HOME}${fs.existsSync(CONFIG) ? "" : "  (not set up: run `pnpm telepi setup`)"}`);
  say(`gateway   ${gw ? "healthy" : "not answering"} (${GATEWAY})`);
  say(`server    ${pid ? `running, pid ${pid}${up ? "" : " (not answering yet)"}` : "stopped"}`);
  say(`url       ${urlOf(cfg)}${cfg.publicUrl ? "" : "  (this machine only; `pnpm telepi pair` sets up HTTPS for the phone)"}`);
  say(`model     ${piModel(cfg) ?? "none chosen in Pi (pick one in the app)"}`);
  say(`pi login  ${pi.found ? pi.providers.join(", ") || "auth.json is empty" : "missing (run `pi`, then /login)"}`);
}

// The server's CLI-only endpoints (apps/server/src/local.ts): loopback, no Origin, and the secret the server wrote to <data dir>/local-token.
async function localApi(cfg, what, body) {
  let token;
  try { token = fs.readFileSync(path.join(cfg.dataDir, "local-token"), "utf8").trim(); } catch { die(`cannot read ${path.join(cfg.dataDir, "local-token")}: is the server running with this data folder?`); }
  try {
    return await fetch(`http://127.0.0.1:${cfg.port}/api/local/${what}`, { method: "POST", headers: { "content-type": "application/json", "x-telepi-local": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (e) { die(`could not reach the server on port ${cfg.port}: ${e.message}`); }
}

/** Asks the running server which model new tasks will run on. Null when the server cannot be asked. */
async function modelState(cfg) {
  try {
    const token = fs.readFileSync(path.join(cfg.dataDir, "local-token"), "utf8").trim();
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/local/models`, { method: "POST", headers: { "content-type": "application/json", "x-telepi-local": token }, body: "{}", signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
/** One line about the model, through a Report: ok with its name, or FAIL with the server's explanation. */
async function checkModel(cfg, r) {
  const m = await modelState(cfg);
  if (!m) return;
  const cur = m.current && (m.available.find((x) => x.provider === m.current.provider && x.id === m.current.id));
  const from = { telepi: "chosen in the app", pi: "Pi's default", env: "TELEPI_MODEL" }[m.source] ?? "";
  r.check(!!m.current, `model ${m.current?.provider}/${cur?.name ?? m.current?.id} (${from})`, "no model new tasks can run on", m.problem ?? "choose one in the app under Settings → Model");
}

// --- pair -------------------------------------------------------------------

function tailscale() {
  const r = run("tailscale", ["status", "--json"]);
  if (r.error || !r.stdout) return { state: r.error ? "missing" : "error" };
  const j = readJson_(r.stdout);
  if (j?.BackendState !== "Running") return { state: "loggedout" };
  return { state: "ok", host: String(j.Self?.DNSName ?? "").replace(/\.$/, "") };
}
function readJson_(t) { try { return JSON.parse(t); } catch { return null; } }

async function pair(cfg = loadCfg()) {
  if (!fs.existsSync(CONFIG)) die("telepi is not set up yet. Run `pnpm telepi setup --tailscale` (or without --tailscale if you do not use Tailscale).");
  if (!(await serverUp(cfg))) die("the server is not running. Start it with `pnpm telepi start`.");
  const ts = tailscale();
  const cmd = `tailscale serve --bg --https=443 http://127.0.0.1:${cfg.port}`;
  let restart = false;
  if (ts.state === "ok" && ts.host) {
    const url = `https://${ts.host}`;
    if (flag("tailscale")) {
      // When Serve is off for the tailnet, tailscale prints a link and waits for it to be turned on: give up after 10 s.
      const r = run("tailscale", ["serve", "--bg", "--https=443", `http://127.0.0.1:${cfg.port}`], { encoding: "utf8", timeout: 10000 });
      if (r.status !== 0) {
        // Tailscale explains itself, often with a link to turn Serve and HTTPS on for the tailnet: show all of it.
        const why = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error ? String(r.error.message) : `exit ${r.status}`);
        say(`  FAIL  tailscale serve did not start. Tailscale says:\n${why.replace(/^\s*/gm, "          ")}`);
        say(`        -> do what it asks (usually: open that link once and turn Serve on), then run \`pnpm telepi pair --tailscale\` again.`);
      }
      else { say(`  ok    tailscale serve is on: ${url}`); if (cfg.publicUrl !== url) { cfg.publicUrl = url; saveCfg(cfg); restart = true; } }
    } else if (cfg.publicUrl !== url) say(`  Tailscale is ready. For HTTPS on your phone (needed for install and notifications) run:\n    ${cmd}\n  or let telepi do it: \`pnpm telepi pair --tailscale\` (next time, \`pnpm telepi setup --tailscale\` does it in one go).`);
  } else if (!cfg.publicUrl) {
    say("  Your phone needs HTTPS to install telepi and get notifications. Two ways:");
    say("    Tailscale (easiest): install it on this machine and the phone, log in, then `pnpm telepi pair --tailscale`.");
    say("    Cloudflare Tunnel: point a tunnel at http://127.0.0.1:" + cfg.port + ", then put the https URL in " + CONFIG + " as \"publicUrl\" and run `pnpm telepi restart`.");
  }
  if (restart) { await stop({ gateway: false }); await start(cfg); }
  const res = await localApi(cfg, "pairing-code", {});
  const code = res.ok ? (await res.json()).code : null;
  if (!code) die(`the server did not give a pairing code (${res.status}). See ${LOGFILE}`);
  const link = `${urlOf(cfg)}/#pair=${code}`;
  say(`\n  Pairing code: ${code}   (valid 10 minutes, one use)`);
  if (!cfg.publicUrl) {
    // A loopback link means nothing to a phone, so there is no QR code until HTTPS works.
    say(`  On this computer: ${link}`);
    say("  On your phone:    not yet. The phone needs an HTTPS address first (see above); then run `pnpm telepi pair` for a QR code.");
    return;
  }
  say(`  Link:         ${link}\n`);
  try { (await import("qrcode-terminal")).default.generate(link, { small: true }, (q) => say(q.replace(/^/gm, "  "))); } catch { say("  (run `pnpm install` to get the QR code)"); }
  say("  Scan it with your phone's camera. Tailscale must be on, on the phone too.");
}

// --- projects ---------------------------------------------------------------

async function projectAdd(src, cfg = loadCfg()) {
  if (!src) die("usage: telepi project add <path-or-git-url>");
  let repo;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(src)) {
    const name = path.basename(src).replace(/\.git$/, "");
    repo = path.join(HOME, "repos", name);
    if (!fs.existsSync(repo)) { say(`  cloning ${src} ...`); if (spawnSync("git", ["clone", src, repo], { stdio: "inherit" }).status !== 0) die("git clone failed (see above)."); }
  } else repo = path.resolve(src);
  const top = run("git", ["-C", repo, "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) die(`${repo} is not a git repository.`);
  repo = fs.realpathSync(top.stdout.trim());
  const origin = run("git", ["-C", repo, "remote", "get-url", "origin"]);
  if (origin.status !== 0) die(`${repo} has no "origin" remote. telepi pushes work back to origin: add one with \`git remote add origin <url>\`.`);
  const url = origin.stdout.trim();
  if (!/^([a-z+]+:\/\/|[^/@]+@[^/]+:)/i.test(url)) {
    const abs = fs.realpathSync(path.resolve(repo, url));
    const root = fs.realpathSync(cfg.remotes);
    if (abs !== root && !abs.startsWith(root + path.sep)) die(`origin is a local folder (${abs}) outside ${root}, which is the only place the sandbox gateway can see. Run setup with --remotes ${path.dirname(abs)} (this recreates the gateway), or use a hosted origin.`);
  }
  const name = path.basename(repo);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  if (await serverUp(cfg)) {
    // The server is running: it adds the project live, and phones see it through the normal sync.
    const res = await localApi(cfg, "projects", { repoPath: repo });
    if (!res.ok) die(`the server refused the project: ${(await res.json().catch(() => ({}))).message ?? res.status}`);
    return say(`  ok    project "${id}" -> ${repo} (origin ${url}), added to the running server`);
  }
  const file = path.join(cfg.dataDir, "projects.json");
  const list = readJson(file, []);
  const i = list.findIndex((p) => p.id === id);
  const entry = { status: "idle", allowedActions: [], ...(i >= 0 ? list[i] : {}), id, name, repoPath: repo };
  if (i >= 0) list[i] = entry; else list.push(entry);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list), { mode: 0o600 });
  say(`  ok    project "${id}" -> ${repo} (origin ${url})`);
}

// --- uninstall --------------------------------------------------------------

const sizeOf = (p) => run("du", ["-sh", p]).stdout?.split("\t")[0] ?? "";
/** The Tailscale Serve config telepi made: HTTPS 443 proxying to this server and nothing else. Null when there is none. */
function ourServe(cfg) {
  const j = readJson_(run("tailscale", ["serve", "status", "--json"]).stdout ?? "");
  const want = `http://127.0.0.1:${cfg.port}`;
  for (const [host, web] of Object.entries(j?.Web ?? {})) {
    const proxies = Object.values(web?.Handlers ?? {}).map((h) => h?.Proxy);
    if (host.endsWith(":443") && proxies.length && proxies.every((p) => p === want)) return `https://${host.replace(/:443$/, "")}`;
  }
  return null;
}

async function uninstall() {
  const cfg = loadCfg();
  const inHome = (p) => p === HOME || p.startsWith(HOME + path.sep);
  const docker = dockerUp();
  const files = [HOME, path.join(GW_DIR, ".env"), TLS_DIR, path.join(GW_DIR, "work"), path.join(REPO, "apps", "web", "dist")].filter((p) => fs.existsSync(p));
  const outside = [...new Set([cfg.workspaces, cfg.remotes, cfg.dataDir])].filter((p) => !inHome(p) && fs.existsSync(p));
  const serve = ourServe(cfg);
  const sandboxes = docker ? dockerIds("ps", "-aq", "--filter", `label=${SANDBOX_LABEL}`) : [];
  const gatewayThere = docker && run("docker", ["inspect", GATEWAY]).status === 0;
  const images = docker ? IMAGES.filter((i) => run("docker", ["image", "inspect", i]).status === 0) : [];
  const nonEmpty = (d) => { try { return fs.readdirSync(d).length > 0; } catch { return false; } };

  say("telepi uninstall\n\nThis stops telepi and removes:");
  say("  - the telepi server");
  // Each sandbox is two containers (the sandbox and its supervisor): count sandboxes.
  const nSandboxes = new Set(dockerIds("ps", "-a", "--filter", `label=${SANDBOX_LABEL}`, "--format", '{{.Label "openshell.ai/sandbox-id"}}')).size;
  if (gatewayThere || sandboxes.length) say(`  - Docker: the OpenShell gateway, its data${nSandboxes ? `, and ${nSandboxes} sandbox${nSandboxes > 1 ? "es" : ""}` : ""}`);
  for (const i of images) say(`  - Docker image ${i}${i === SANDBOX_IMAGE ? " (the sandbox image; Docker pulls it again if something else needs it)" : ""}`);
  if (serve) say(`  - Tailscale Serve for ${serve} (Tailscale itself stays)`);
  for (const f of files) say(`  - ${f}  ${sizeOf(f)}`);
  if (inHome(cfg.workspaces) && nonEmpty(cfg.workspaces)) say("      includes the task workspaces: work an agent did that was never published is lost");
  if (inHome(cfg.remotes) && nonEmpty(cfg.remotes)) say(`      includes ${cfg.remotes}: anything you put there yourself goes too`);
  if (!docker) say("  (Docker is not running, so the gateway, sandboxes and images cannot be removed now. Start Docker first to remove them too.)");
  say("\nKept: your projects' own repositories, your Pi login (~/.pi), Tailscale, Docker, and this checkout.");
  for (const p of outside) say(`Kept, because you chose it and it is outside ${HOME}: ${p}`);

  if (!flag("yes")) {
    if (!process.stdin.isTTY) die("run `pnpm telepi uninstall --yes` to confirm.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl+C or Ctrl+D is a no.
    const answer = (await rl.question("\nRemove all of this? [y/N] ").catch(() => "")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") return say("Nothing was changed.");
  }
  say("");

  await stop({ gateway: false });
  if (docker) {
    if (sandboxes.length) { run("docker", ["rm", "-f", ...sandboxes], { timeout: 60000 }); ok("sandbox containers removed"); }
    const vols = dockerIds("volume", "ls", "-q", "--filter", `label=${SANDBOX_LABEL}`);
    if (vols.length) run("docker", ["volume", "rm", "-f", ...vols]);
    // The gateway's data lives in Docker's VM, not in a folder you can see: a throwaway container empties it.
    if (run("docker", ["image", "inspect", SANDBOX_IMAGE]).status === 0)
      run("docker", ["run", "--rm", "--pull", "never", "-v", `${GW_DATA}:/d`, SANDBOX_IMAGE, "sh", "-c", "rm -rf /d/* /d/.[!.]*"], { timeout: 60000 });
    const down = run("docker", ["compose", "-p", COMPOSE_PROJECT, "--profile", "spike", "--profile", "tools", "down", "--volumes", "--remove-orphans"],
      { cwd: GW_DIR, timeout: 120000, env: { ...process.env, TELEPI_WORKSPACES: cfg.workspaces, TELEPI_REMOTES: cfg.remotes } });
    if (down.status === 0) ok("gateway removed"); else bad(`gateway: docker compose down failed: ${(down.stderr || "").trim().split("\n").pop()}`, `docker rm -f ${GATEWAY}`);
    for (const i of images) { const r = run("docker", ["rmi", i], { timeout: 60000 }); r.status === 0 ? ok(`image ${i} removed`) : say(`  ..    image ${i} kept: ${(r.stderr || "").trim().split("\n").pop()}`); }
  }
  if (serve) {
    const r = run("tailscale", ["serve", "--https=443", "off"]);
    r.status === 0 ? ok(`Tailscale Serve off (${serve})`) : bad("could not turn Tailscale Serve off", "tailscale serve reset");
  }
  for (const f of files) { fs.rmSync(f, { recursive: true, force: true }); ok(`removed ${f}`); }
  say(`\ntelepi is uninstalled. To remove the code as well: rm -rf ${REPO}`);
}

// --- main -------------------------------------------------------------------

const [cmd, sub] = args;
const help = `telepi <command>
  setup [--project <path-or-url>]...  prepare everything, start telepi, show the QR for your phone (safe to re-run)
  doctor                              check everything and say what to fix (changes nothing)
  start | stop | restart | status     stop ends everything (server, sandboxes, gateway); restart only the server
  pair [--tailscale]                  new pairing code, link and QR (--tailscale also runs \`tailscale serve\`)
  project add <path-or-git-url>
  uninstall [--yes]                   stop telepi and remove everything it made (lists it and asks first)
Options for setup: --port N, --workspaces DIR, --remotes DIR. Home folder: ${HOME} (override with TELEPI_HOME).`;
switch (cmd) {
  case "setup": await setup(); break;
  case "doctor": await doctor(); break;
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "restart": await stop({ gateway: false }); await start(); break;
  case "uninstall": await uninstall(); break;
  case "status": await status(); break;
  case "pair": await pair(); break;
  case "project": if (sub === "add") await projectAdd(args[2]); else say(help); break;
  default: say(help);
}
