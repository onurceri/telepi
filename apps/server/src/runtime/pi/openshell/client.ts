// A thin gRPC client for the OpenShell gateway (v0.1.3). Protos are vendored next to this file in ./proto.
// Only the calls telepi needs are wrapped. Wire quirks (see deploy/openshell/README.md): proto3 omits exit code 0, and
// google.protobuf.Struct fields use the {fields:{...}} shape.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WORKSPACE = { workspace: "default" };
const PROTO_DIR = fileURLToPath(new URL("./proto", import.meta.url));

type Json = Record<string, unknown>;
type Unary = (req: Json, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, r: Json) => void) => grpc.ClientUnaryCall;
type RawClient = grpc.Client & Record<string, unknown>;

export interface ExecRequest {
  command: string[];
  workdir?: string;
  env?: Record<string, string>;
  /** Killed by the gateway after this many seconds (exit code 124). */
  timeoutSecs?: number;
  stdin?: Uint8Array;
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

export interface DraftChunk {
  id: string;
  ruleName: string;
  binary: string;
  rationale: string;
  securityNotes: string;
  confidence: number;
  reviewToken: string;
  hitCount: number;
  endpoints: { host: string; port: number }[];
}

export interface SandboxInfo {
  name: string;
  phase: string;
  conditions: string;
}

export interface CreateSandboxRequest {
  name: string;
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: { source: string; target: string; readOnly?: boolean }[];
  policy: PolicyInput;
  command: string[];
}

/** Paths of the PEM files for a mutually authenticated connection to the gateway. */
export interface TlsFiles {
  ca: string;
  cert: string;
  key: string;
  /** The name to check the gateway's certificate against; the gateway is addressed by IP, which Node will not send as a name. */
  serverName?: string;
}

/** One line of a sandbox's log, as the gateway relays it from the supervisor. */
export interface SandboxLog {
  level: string;
  message: string;
  /** Milliseconds since the epoch, when the supervisor wrote it (0 when unknown). */
  at: number;
}

export interface PolicyStatus {
  /** The policy version the sandbox has loaded. */
  active: number;
  /** Status of the queried revision: LOADED, PENDING, FAILED or SUPERSEDED. */
  status: string;
  error: string;
}

/** One HTTP request pattern: method and a path glob ("*" is one segment, "**" any number). */
export interface HttpAllow {
  method: string;
  path: string;
}

/**
 * A host and port. With `http`, the supervisor terminates TLS, reads each request and lets through only those that
 * match (everything else gets a 403 and a log line); without it the connection is opened for any bytes (L4).
 */
export interface NetworkEndpointSpec {
  host: string;
  port: number;
  http?: HttpAllow[];
}

export interface NetworkRule {
  name: string;
  endpoints: NetworkEndpointSpec[];
  binaries: string[];
}

export interface PolicyInput {
  readOnly: string[];
  readWrite: string[];
  /** Network rules, by rule name. Empty means default deny. */
  network?: Record<string, { endpoints: NetworkEndpointSpec[]; binaries: string[] }>;
}

const endpointOf = (e: NetworkEndpointSpec): Json => ({
  host: e.host,
  port: e.port,
  ports: [e.port],
  ...(e.http ? { protocol: "rest", enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE", rules: e.http.map((allow) => ({ allow })) } : {}),
});

const toValue = (v: unknown): Json =>
  v === null ? { nullValue: 0 } : Array.isArray(v) ? { listValue: { values: v.map(toValue) } }
  : typeof v === "object" ? { structValue: toStruct(v as Json) } : typeof v === "string" ? { stringValue: v }
  : typeof v === "boolean" ? { boolValue: v } : { numberValue: v };
const toStruct = (o: Json): Json => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)])) });

export class OpenShellClient {
  private client: RawClient;

  constructor(readonly address: string, tls?: TlsFiles) {
    const def = protoLoader.loadSync("openshell.proto", { includeDirs: [PROTO_DIR], keepCase: true, longs: String, enums: String, defaults: false, oneofs: true });
    const pkg = grpc.loadPackageDefinition(def) as unknown as { openshell: { v1: { OpenShell: new (a: string, c: grpc.ChannelCredentials, o?: object) => RawClient } } };
    const credentials = tls
      ? grpc.credentials.createSsl(readFileSync(tls.ca), readFileSync(tls.key), readFileSync(tls.cert))
      : grpc.credentials.createInsecure();
    const name = tls ? { "grpc.ssl_target_name_override": tls.serverName ?? "localhost", "grpc.default_authority": tls.serverName ?? "localhost" } : {};
    this.client = new pkg.openshell.v1.OpenShell(address, credentials, { "grpc.max_receive_message_length": 64 * 1024 * 1024, ...name });
  }

  close(): void {
    this.client.close();
  }

  private call(method: string, req: Json, deadlineMs = 30_000): Promise<Json> {
    return new Promise((resolve, reject) => {
      (this.client[method] as Unary).call(this.client, req, { deadline: Date.now() + deadlineMs }, (e: grpc.ServiceError | null, r: Json) => (e ? reject(e) : resolve(r)));
    });
  }

  async health(): Promise<string> {
    const r = await this.call("Health", {}, 5000);
    return String(r.version ?? "");
  }

  // --- sandboxes ---------------------------------------------------------------

  async createSandbox(req: CreateSandboxRequest): Promise<void> {
    const network = Object.fromEntries(
      Object.entries(req.policy.network ?? {}).map(([name, rule]) => [name, { name, endpoints: rule.endpoints.map(endpointOf), binaries: rule.binaries.map((path) => ({ path })) }]),
    );
    await this.call("CreateSandbox", {
      workspace_scope: WORKSPACE,
      name: req.name,
      labels: req.labels,
      spec: {
        command: req.command,
        environment: req.env,
        template: {
          image: req.image,
          driver_config: toStruct({ docker: { mounts: req.mounts.map((m) => ({ type: "bind", source: m.source, target: m.target, read_only: m.readOnly ?? false })) } }),
        },
        policy: {
          version: 1,
          filesystem: { include_workdir: true, read_only: req.policy.readOnly, read_write: req.policy.readWrite },
          landlock: { compatibility: "hard_requirement" },
          network_policies: network,
        },
      },
    });
  }

  async getSandbox(name: string): Promise<SandboxInfo | null> {
    try {
      return toInfo(((await this.call("GetSandbox", { workspace_scope: WORKSPACE, name })).sandbox ?? {}) as Json);
    } catch (e) {
      if ((e as grpc.ServiceError).code === grpc.status.NOT_FOUND) return null;
      throw e;
    }
  }

  async waitReady(name: string, timeoutMs = 120_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.getSandbox(name);
      if (info?.phase === "SANDBOX_PHASE_READY") return;
      if (!info || info.phase === "SANDBOX_PHASE_ERROR") throw new Error(`The OpenShell sandbox did not start: ${info?.conditions || "it is gone"}`);
      if (Date.now() > end) throw new Error(`The OpenShell sandbox was not ready after ${Math.round(timeoutMs / 1000)}s (${info.phase}).`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async listSandboxes(labelSelector: string): Promise<SandboxInfo[]> {
    const r = await this.call("ListSandboxes", { workspace_scope: WORKSPACE, label_selector: labelSelector });
    return ((r.sandboxes as Json[] | undefined) ?? []).map(toInfo);
  }

  async deleteSandbox(name: string): Promise<void> {
    try {
      await this.call("DeleteSandbox", { workspace_scope: WORKSPACE, name });
    } catch (e) {
      if ((e as grpc.ServiceError).code !== grpc.status.NOT_FOUND) throw e;
    }
  }

  /**
   * Deletes a sandbox and waits until the gateway has really let go of it. DeleteSandbox answers while the sandbox is
   * still being torn down, and one created under the same name in that window is taken down with it.
   */
  async deleteSandboxAndWait(name: string, timeoutMs = 30_000): Promise<void> {
    await this.deleteSandbox(name);
    const end = Date.now() + timeoutMs;
    while ((await this.getSandbox(name)) !== null) {
      if (Date.now() > end) throw new Error(`The OpenShell gateway did not remove the old sandbox ${name} within ${Math.round(timeoutMs / 1000)}s.`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // --- exec --------------------------------------------------------------------

  /** Runs a command and resolves with its exit code. Aborting the signal cancels the stream. */
  exec(sandbox: string, req: ExecRequest): Promise<number> {
    return new Promise((resolve, reject) => {
      const body: Json = { workspace_scope: WORKSPACE, sandbox, command: req.command, workdir: req.workdir ?? "", environment: req.env ?? {}, no_login_shell: true };
      if (req.timeoutSecs) body.execution_timeout = { seconds: String(req.timeoutSecs), nanos: 0 };
      if (req.stdin) body.stdin = Buffer.from(req.stdin);
      const stream = (this.client.ExecSandbox as (r: Json) => grpc.ClientReadableStream<Json>).call(this.client, body);
      let exit: number | null = null;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        req.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        stream.cancel();
        finish(() => reject(new Error("aborted")));
      };
      if (req.signal?.aborted) return onAbort();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      stream.on("data", (ev: { stdout?: { data: Buffer }; stderr?: { data: Buffer }; exit?: { exit_code?: number } }) => {
        if (ev.stdout) req.onStdout?.(ev.stdout.data);
        else if (ev.stderr) req.onStderr?.(ev.stderr.data);
        else if (ev.exit) exit = ev.exit.exit_code ?? 0; // proto3 omits 0
      });
      stream.on("error", (e: Error) => finish(() => reject(e)));
      stream.on("end", () => finish(() => (exit === null ? reject(new Error("The command ended without an exit code.")) : resolve(exit))));
    });
  }

  // --- network approvals -------------------------------------------------------

  async pendingChunks(sandbox: string): Promise<DraftChunk[]> {
    const r = await this.call("GetDraftPolicy", { workspace_scope: WORKSPACE, sandbox, status_filter: "pending" }, 10_000);
    return ((r.chunks as Json[] | undefined) ?? []).map((c) => ({
      id: String(c.id),
      ruleName: String(c.rule_name ?? ""),
      binary: String(c.binary ?? ""),
      rationale: String(c.rationale ?? ""),
      securityNotes: String(c.security_notes ?? ""),
      confidence: Number(c.confidence ?? 0),
      reviewToken: String(c.review_token ?? ""),
      hitCount: Number(c.hit_count ?? 0),
      endpoints: (((c.proposed_rule as Json | undefined)?.endpoints as Json[] | undefined) ?? []).map((e) => ({ host: String(e.host), port: Number(e.port ?? 0) })),
    }));
  }

  async rejectChunk(sandbox: string, chunkId: string, reason: string): Promise<void> {
    await this.call("RejectDraftChunk", { workspace_scope: WORKSPACE, sandbox, chunk_id: chunkId, reason });
  }

  // --- lifecycle, policy, logs -------------------------------------------------

  async stopSandbox(name: string): Promise<void> {
    await this.call("StopSandbox", { workspace_scope: WORKSPACE, name });
  }

  async startSandbox(name: string): Promise<void> {
    await this.call("StartSandbox", { workspace_scope: WORKSPACE, name });
  }

  /**
   * Adds network rules to a running sandbox's policy (the gateway merges them). Returns the new policy version; the
   * sandbox has it only once policyStatus reports it as active.
   */
  async addNetworkRules(sandbox: string, rules: NetworkRule[]): Promise<number> {
    const merge_operations = rules.map((r) => ({
      add_rule: {
        rule_name: r.name,
        rule: {
          name: r.name,
          endpoints: r.endpoints.map(endpointOf),
          binaries: r.binaries.map((path) => ({ path })),
        },
      },
    }));
    const r = await this.call("UpdateConfig", { workspace_scope: WORKSPACE, sandbox, merge_operations });
    return Number(r.version ?? 0);
  }

  async policyStatus(sandbox: string, version: number): Promise<PolicyStatus> {
    const r = await this.call("GetSandboxPolicyStatus", { workspace_scope: WORKSPACE, sandbox, version }, 10_000);
    const revision = (r.revision as Json | undefined) ?? {};
    return {
      active: Number(r.active_version ?? 0),
      status: String(revision.status ?? "").replace("POLICY_STATUS_", ""),
      error: String(revision.load_error ?? ""),
    };
  }

  /**
   * Follows the supervisor's log lines of a sandbox as they happen (about half a second behind). Resolves when the
   * returned stop function is called or the stream ends; `onEnd` runs then, with the error if there was one.
   */
  watchLogs(sandbox: string, onLog: (log: SandboxLog) => void, onEnd: (error?: Error) => void): () => void {
    // Only lines from now on: without since_time the gateway replays the sandbox's recent log first.
    const since = Date.now() - 1000;
    const stream = (this.client.WatchSandbox as (r: Json) => grpc.ClientReadableStream<Json>).call(this.client, {
      workspace_scope: WORKSPACE, sandbox, follow_status: false, follow_logs: true, follow_events: false,
      log_sources: ["sandbox"], since_time: { seconds: String(Math.floor(since / 1000)), nanos: (since % 1000) * 1e6 },
    });
    let stopped = false;
    stream.on("data", (ev: { log?: { level?: string; message?: string; event_time?: { seconds?: string; nanos?: number } } }) => {
      if (!ev.log) return;
      const t = ev.log.event_time;
      onLog({ level: ev.log.level ?? "", message: ev.log.message ?? "", at: t?.seconds ? Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6) : 0 });
    });
    stream.on("error", (e: Error & { code?: number }) => {
      if (!stopped) onEnd(e);
    });
    stream.on("end", () => {
      if (!stopped) onEnd();
    });
    return () => {
      stopped = true;
      stream.cancel();
    };
  }

  // --- providers ---------------------------------------------------------------

  /** Imports a provider profile as a platform (global) profile, like `profile import --global`. */
  async importProfile(profile: Json): Promise<void> {
    const r = await this.call("ImportProviderProfiles", { profiles: [{ profile, source: "telepi" }] });
    if (r.imported !== true) throw new Error(`OpenShell did not import the provider profile: ${JSON.stringify(r.diagnostics ?? r)}`);
  }

  async hasProfile(id: string): Promise<boolean> {
    try {
      await this.call("GetProviderProfile", { id });
      return true;
    } catch (e) {
      if ((e as grpc.ServiceError).code === grpc.status.NOT_FOUND) return false;
      throw e;
    }
  }

  async createProvider(name: string, type: string, credentials: Record<string, string>): Promise<void> {
    await this.call("CreateProvider", { workspace_scope: WORKSPACE, provider: { metadata: { name }, type, credentials } });
  }

  /** Removes a provider; none attached to a sandbox may use it. Missing is fine. */
  async deleteProvider(name: string): Promise<void> {
    await this.call("DeleteProvider", { workspace_scope: WORKSPACE, name, allow_missing: true });
  }

  async deleteProfile(id: string): Promise<void> {
    await this.call("DeleteProviderProfile", { id, allow_missing: true });
  }

  async hasProvider(name: string): Promise<boolean> {
    try {
      await this.call("GetProvider", { workspace_scope: WORKSPACE, name });
      return true;
    } catch (e) {
      if ((e as grpc.ServiceError).code === grpc.status.NOT_FOUND) return false;
      throw e;
    }
  }

  /** Returns the receipt id to follow the change with providerStatus. */
  async attachProvider(sandbox: string, provider: string): Promise<string> {
    const r = await this.call("AttachSandboxProvider", { workspace_scope: WORKSPACE, sandbox, provider });
    return String((r.receipt as Json | undefined)?.receipt_id ?? "");
  }

  async detachProvider(sandbox: string, provider: string): Promise<string> {
    const r = await this.call("DetachSandboxProvider", { workspace_scope: WORKSPACE, sandbox, provider });
    return String((r.receipt as Json | undefined)?.receipt_id ?? "");
  }

  async providerStatus(sandbox: string, provider: string, receiptId: string): Promise<{ state: string; reason: string }> {
    const r = await this.call("GetSandboxProviderStatus", { workspace_scope: WORKSPACE, sandbox, provider, receipt_id: receiptId });
    const status = (r.status as Json | undefined) ?? {};
    return { state: String(status.state ?? "").replace("PROVIDER_READINESS_STATE_", ""), reason: String(status.reason ?? "").replace("PROVIDER_READINESS_REASON_", "") };
  }

  /** Raw call for experiments and for the few places that need a message the wrapper does not cover. */
  raw(method: string, req: Json): Promise<Json> {
    return this.call(method, { workspace_scope: WORKSPACE, ...req });
  }
}

function toInfo(s: Json): SandboxInfo {
  const status = (s.status as Json | undefined) ?? {};
  const conditions = ((status.conditions as Json[] | undefined) ?? []).map((c) => `${c.reason ?? c.type}: ${c.message ?? ""}`).join("; ");
  return { name: String((s.metadata as Json | undefined)?.name ?? ""), phase: String(status.phase ?? ""), conditions };
}
