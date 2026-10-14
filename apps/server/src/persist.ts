// JSON files in the data dir. Writes are atomic (temp file + rename) and debounced.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const DEBOUNCE_MS = 250;

export class Persist {
  private dirty = new Map<string, () => unknown>();
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Returns undefined when the file does not exist. Throws on a corrupt file rather than silently losing data. */
  read(name: string): unknown {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dir, name), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Corrupt JSON in ${path.join(this.dir, name)}`);
    }
  }

  /** Write `produce()` to the file soon. Several calls before the flush collapse into one write. */
  schedule(name: string, produce: () => unknown): void {
    this.dirty.set(name, produce);
    this.timer ??= setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  /** Write everything pending now. Used on shutdown. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.dirty];
    this.dirty.clear();
    for (const [name, produce] of pending) {
      try {
        this.writeNow(name, produce());
      } catch (err) {
        console.error(`telepi: failed to write ${name}:`, err);
      }
    }
  }

  writeNow(name: string, value: unknown): void {
    const file = path.join(this.dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  appendLine(name: string, value: unknown): void {
    try {
      fs.appendFileSync(path.join(this.dir, name), JSON.stringify(value) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error(`telepi: failed to append to ${name}:`, err);
    }
  }
}
