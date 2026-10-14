// The OpenShell sandbox backend: one OpenShell sandbox per live task, created over gRPC. The supervisor, not telepi,
// controls the network; telepi only turns what it denies into approvals (see ../network.ts).
import type { RunResult, SandboxBackend, SandboxSpec, TaskSandbox } from "../sandbox";
import { endpointsFor } from "../egress";
import { ensureGithubProvider, removeGithubProvider, type GithubConfig } from "../github";
import { OpenShellClient, type TlsFiles } from "./client";
import { NETWORK_BINARIES, OpenShellControl } from "./control";
import { OpenShellEnv } from "./env";

export { OpenShellControl } from "./control";
export type { DraftChunk } from "./client";

export const OPENSHELL_IMAGE = "node:22-bookworm";
const LABEL = "telepi";
const IDENTITY = { GIT_AUTHOR_NAME: "telepi agent", GIT_AUTHOR_EMAIL: "agent@telepi.local", GIT_COMMITTER_NAME: "telepi agent", GIT_COMMITTER_EMAIL: "agent@telepi.local" };
const READ_ONLY = ["/bin", "/usr", "/lib", "/proc", "/dev/urandom", "/etc", "/var/log"];

// The gateway limits sandbox names to 19 characters.
const nameOf = (taskId: string) => `t-${taskId.replace(/^task_/, "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16)}`;

/** Fails with a readable message when the gateway cannot be reached. */
export async function checkGateway(address: string, tls?: TlsFiles): Promise<OpenShellClient> {
  const client = new OpenShellClient(address, tls);
  try {
    await client.health();
  } catch (error) {
    client.close();
    throw new Error(
      `TELEPI_RUNTIME=pi needs OpenShell, but the gateway at ${address} did not answer (${error instanceof Error ? error.message : String(error)}). ` +
        `Start it with "docker compose up -d" in deploy/openshell, or set OPENSHELL_GATEWAY.`,
    );
  }
  return client;
}

export function openshellBackend(client: OpenShellClient, github: GithubConfig | null): SandboxBackend {
  return {
    async prepare() {
      // A crashed server leaves its sandboxes behind in the gateway; they are all ours (labelled), so remove them.
      const left = await client.listSandboxes(`${LABEL}=1`);
      await Promise.all(left.map((s) => client.deleteSandboxAndWait(s.name).catch((e: Error) => console.warn(`telepi: ${e.message}`))));
      // After the sandboxes: nothing has the provider attached, so it can be made again with the current token.
      if (github) await ensureGithubProvider(client, github);
      else await removeGithubProvider(client).catch((e: Error) => console.warn(`telepi: could not remove the old GitHub provider: ${e.message}`));
    },

    async start(spec: SandboxSpec): Promise<TaskSandbox> {
      const name = nameOf(spec.taskId);
      const paths = [spec.workspace, ...spec.extraMounts];
      const endpoints = endpointsFor(spec.allowedHosts.map(splitHost), spec.allowedSends);
      const network = endpoints.length ? { project_allowed: { endpoints, binaries: NETWORK_BINARIES } } : undefined;
      // A sandbox can be lost while it comes up (the gateway still clearing an older one of the same name, a slow
      // supervisor). That is worth a second and a third try before the task is told it has nowhere to work.
      for (let attempt = 1; ; attempt++) {
        await client.deleteSandboxAndWait(name);
        await client.createSandbox({
          name,
          image: OPENSHELL_IMAGE,
          labels: { [LABEL]: "1", "telepi-task": spec.taskId },
          env: { HOME: "/tmp/agent-home", NPM_CONFIG_UPDATE_NOTIFIER: "false", GIT_TERMINAL_PROMPT: "0", ...IDENTITY },
          mounts: paths.map((source) => ({ source, target: source })),
          policy: { readOnly: READ_ONLY, readWrite: ["/tmp", "/dev/null", ...paths], network },
          command: ["sleep", "infinity"],
        });
        try {
          await client.waitReady(name);
          break;
        } catch (error) {
          await client.deleteSandbox(name).catch(() => {});
          if (attempt >= 3) throw error;
          console.warn(`telepi: sandbox ${name} did not come up (${error instanceof Error ? error.message : error}); trying again`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      const control = new OpenShellControl(client, name);
      const env = new OpenShellEnv(client, control, spec.workspace);
      return new OpenShellSandbox(client, control, env, spec.workspace);
    },
  };
}

function splitHost(hostPort: string): { host: string; port: number } {
  const i = hostPort.lastIndexOf(":");
  return { host: hostPort.slice(0, i), port: Number(hostPort.slice(i + 1)) };
}

class OpenShellSandbox implements TaskSandbox {
  private removed = false;

  constructor(
    private client: OpenShellClient,
    readonly openshell: OpenShellControl,
    readonly env: OpenShellEnv,
    private workspace: string,
  ) {}

  async run(argv: string[]): Promise<RunResult> {
    const r = await this.openshell.run({ argv, cwd: this.workspace, timeoutMs: 120_000 });
    return { code: r.outcome.kind === "exit" ? r.outcome.code : 124, stdout: r.stdout, stderr: r.stderr };
  }

  async remove(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    await this.client.deleteSandbox(this.openshell.name);
  }
}
