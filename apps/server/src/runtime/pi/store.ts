// What the Pi runtime keeps per task besides the Pi Durable conversation: where its workspace is and which
// conversation it maps to. A small JSON file, written synchronously so a crash never loses a mapping.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TaskMeta {
  conversationId: number;
  workspace: string;
  branch: string;
  base: string;
  /** The project repo's default branch when the workspace was made: what a pull request is opened against. */
  defaultBranch?: string;
  /** The model this task's conversation was created with (Durable keeps it; this is for the context window). */
  model?: { provider: string; id: string };
  /** The project repo's origin URL, as recorded when the workspace was made (not read back from the clone). */
  originUrl: string;
  /** The commit the branch was at when the work last went to review. Diffs after the sandbox is gone use it. */
  head?: string;
  /** Number of inputs submitted so far (the instruction, then each round of requested changes). */
  round: number;
  /** The text of the input of the current round, so a crash between counting it and submitting it loses nothing. */
  pendingInput: string | null;
  /** How the last finished round ended, so its review can be shown again after a restart. */
  outcome?: { kind: "done" | "failed"; text: string };
  /** Steps that were started but not finished, so a restart can close them. */
  openSteps: string[];
}

export class MetaStore {
  private file: string;
  private data: Record<string, TaskMeta> = {};

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "tasks.json");
    if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, TaskMeta>;
  }

  get(taskId: string): TaskMeta | undefined {
    return this.data[taskId];
  }

  set(taskId: string, meta: TaskMeta): void {
    this.data[taskId] = meta;
    this.save();
  }

  update(taskId: string, patch: Partial<TaskMeta>): void {
    const meta = this.data[taskId];
    if (!meta) return;
    this.data[taskId] = { ...meta, ...patch };
    this.save();
  }

  taskIdOfConversation(conversationId: number): string | undefined {
    return Object.entries(this.data).find(([, m]) => m.conversationId === conversationId)?.[0];
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
