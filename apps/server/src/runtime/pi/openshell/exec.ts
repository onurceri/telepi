// Running a command in a sandbox through ExecSandbox, with a timeout and an abort that really end the process.
// Observed on OpenShell 0.1.3: neither `execution_timeout` (reports exit 124) nor cancelling the gRPC stream kills what
// the command started; a second exec cannot signal it (EPERM, each exec has its own Landlock domain); and the seccomp
// filter refuses kill() on a process group. So every command runs under a small wrapper in the same exec: a watchdog
// next to the command waits for a "kill file", then stops and kills the command and all its descendants one by one.
// Cancelling means creating that file. Processes that already detached from the tree (parent gone) are out of reach.
import { randomUUID } from "node:crypto";
import type { OpenShellClient } from "./client";

const DIR = "/tmp/.telepi";
// $1 is the id, the rest the real argv. stdin is passed on explicitly (async commands would get /dev/null).
const WRAP = [
  `d=${DIR}; mkdir -p "$d"; id=$1; shift`,
  `tree() { echo $1; for c in $(ps -o pid= --ppid $1); do tree $c; done; }`,
  `"$@" <&0 & pid=$!`,
  `( while kill -0 $pid 2>/dev/null; do if [ -e "$d/$id.kill" ]; then all=$(tree $pid); kill -STOP $all 2>/dev/null; kill -KILL $all 2>/dev/null; exit 0; fi; sleep 0.2; done ) & wd=$!`,
  `wait $pid; code=$?; kill $wd 2>/dev/null; rm -f "$d/$id.kill"; exit $code`,
].join("\n");
const CANCEL = `mkdir -p ${DIR}; touch ${DIR}/$1.kill`;

// Lists processes younger than $1 seconds that are still alive, apart from this scan itself. Reading the environment
// of another exec's process is refused (EACCES), so a marker variable cannot be used; the age window is the tracking.
const SCAN = `me=$$; ps -eo pid=,ppid=,stat=,etimes=,comm= | while read pid ppid stat age comm; do
  case "$stat" in Z*) continue;; esac
  [ "$pid" = "$me" ] || [ "$ppid" = "$me" ] && continue
  [ "$age" -le "$1" ] && echo "$pid $comm"
done`;

export interface RunRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

/** A process that was started during a command that was timed out or aborted, and is still alive. */
export interface Survivor {
  pid: number;
  command: string;
}

export type RunOutcome = { kind: "exit"; code: number } | { kind: "timeout"; survivors: Survivor[] } | { kind: "aborted"; survivors: Survivor[] };

/** Ids of commands that are running, so a shutdown can kill them all. */
export class ExecTracker {
  readonly active = new Set<string>();
}

export async function runCommand(client: OpenShellClient, sandbox: string, req: RunRequest, tracker?: ExecTracker): Promise<RunOutcome> {
  const id = randomUUID().slice(0, 12);
  const startedAt = Date.now();
  tracker?.active.add(id);
  const stop = new AbortController();
  let reason: "timeout" | "aborted" | null = null;
  const timer = req.timeoutMs ? setTimeout(() => { reason = "timeout"; stop.abort(); }, req.timeoutMs) : undefined;
  const onAbort = () => { reason ??= "aborted"; stop.abort(); };
  if (req.signal?.aborted) onAbort();
  else req.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const code = await client.exec(sandbox, {
      command: ["bash", "-c", WRAP, "telepi", id, ...req.argv],
      workdir: req.cwd,
      env: req.env,
      stdin: req.stdin,
      signal: stop.signal,
      onStdout: req.onStdout,
      onStderr: req.onStderr,
    });
    return reason ? { kind: reason, survivors: [] } : { kind: "exit", code };
  } catch (error) {
    if (!reason) throw error;
    await killCommand(client, sandbox, id);
    return { kind: reason, survivors: await survivorsSince(client, sandbox, startedAt) };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
    tracker?.active.delete(id);
  }
}

/** Asks the watchdog of a command started by runCommand to kill it. Best effort. */
export async function killCommand(client: OpenShellClient, sandbox: string, id: string): Promise<void> {
  await client.exec(sandbox, { command: ["bash", "-c", CANCEL, "telepi", id] }).catch(() => {});
}

/** Processes that this command started (the sandbox ran nothing else meanwhile) and that outlived the watchdog. */
export async function survivorsSince(client: OpenShellClient, sandbox: string, startedAt: number): Promise<Survivor[]> {
  await new Promise((r) => setTimeout(r, 300)); // let the watchdog finish
  const window = Math.ceil((Date.now() - startedAt) / 1000) + 1;
  const out: Buffer[] = [];
  try {
    await client.exec(sandbox, { command: ["bash", "-c", SCAN, "telepi", String(window)], timeoutSecs: 20, onStdout: (d) => out.push(d) });
  } catch {
    return [];
  }
  return Buffer.concat(out).toString().split("\n").filter(Boolean).map((line) => {
    const [pid, ...rest] = line.split(" ");
    return { pid: Number(pid), command: rest.join(" ") };
  });
}
