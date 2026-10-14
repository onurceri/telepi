// What the session needs from a sandbox: create one for a task, run commands in it (through its execution environment
// or directly), and destroy it. OpenShell provides it; the interface keeps the session independent of gRPC.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Send } from "./egress";
import type { OpenShellControl } from "./openshell/control";

export interface SandboxSpec {
  taskId: string;
  projectId: string;
  workspace: string;
  /** Extra host paths to mount at the same path (a local origin remote). */
  extraMounts: string[];
  /** Hosts ("host:port") the project has allowed permanently. Opened in the sandbox's network policy from the start. */
  allowedHosts: string[];
  /** Sends (a POST, a git push, ...) the project has allowed permanently, on top of reading from allowedHosts. */
  allowedSends: Send[];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TaskSandbox {
  /** The execution environment of the agent's tools: commands and file operations both run in the sandbox. */
  readonly env: ExecutionEnv;
  /** Runs a command in the sandbox (host-side helper, not for the model). */
  run(argv: string[]): Promise<RunResult>;
  /** Destroys the sandbox. Safe to call twice. */
  remove(): Promise<void>;
  /** Network approvals and credential providers. */
  readonly openshell: OpenShellControl;
}

export interface SandboxBackend {
  /** Once per server start: make sure the backend can work, and remove sandboxes a dead process left behind. */
  prepare(): Promise<void>;
  start(spec: SandboxSpec): Promise<TaskSandbox>;
}
