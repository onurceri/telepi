// The file half of an OpenShell sandbox's execution environment. Every operation is a small command run inside the
// sandbox through ExecSandbox (cat, tee, find, mkdir, ...), so the sandbox's Landlock rules decide what a path may be:
// the telepi server never opens a path the agent chose. File content travels over stdin and stdout, which are bytes,
// so binary files work.
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  err,
  ok,
  FileError,
  LineScanner,
  StreamDecoder,
  type BinaryReader,
  type DirReader,
  type FileInfo,
  type FileKind,
  type FileSystem,
  type LineScan,
  type Result,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
  type FileWatcher,
} from "@earendil-works/pi-durable/env";
import type { OpenShellClient } from "./client";

type R<T> = Promise<Result<T, FileError>>;

/** Content larger than this is written in several commands: the gateway refuses a request over 1 MiB (verified). */
const WRITE_CHUNK = 512 * 1024;
/** A binary reader fetches at least this much per command and serves the following reads from it. */
const READ_WINDOW = 1024 * 1024;
/** The line reader loads the whole file; it is not used by the coding tools, so a limit is fine. */
const TEXT_LINE_LIMIT = 32 * 1024 * 1024;

const STAT = `find "$@" -maxdepth 0 -printf '%y\\0%s\\0%T@\\0'`;
const LIST = `find "$1" -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0'`;

interface Out {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Maps what a coreutils command said on stderr to a FileError code. */
export function fileError(stderr: string, target: string): FileError {
  const message = stderr.trim().split("\n")[0] || `Could not access ${target}`;
  if (/No such file or directory/i.test(message)) return new FileError("not_found", message, target);
  if (/Permission denied|Operation not permitted/i.test(message)) return new FileError("permission_denied", message, target);
  if (/Not a directory/i.test(message)) return new FileError("not_directory", message, target);
  if (/Is a directory/i.test(message)) return new FileError("is_directory", message, target);
  return new FileError("unknown", message, target);
}

const aborted = (context: Context, target?: string): Result<never, FileError> | undefined =>
  context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", target)) : undefined;

const toKind = (letter: string): FileKind | null => (letter === "f" ? "file" : letter === "d" ? "directory" : letter === "l" ? "symlink" : null);

export abstract class SandboxFileSystem implements FileSystem {
  readonly id: string;

  constructor(
    protected client: OpenShellClient,
    protected sandbox: string,
    public cwd: string,
  ) {
    this.id = `openshell:${sandbox}`;
  }

  abstract cleanup(context: Context): Promise<void>;

  // --- the one primitive --------------------------------------------------------

  /** Runs a command in the sandbox and collects its output. Rejects only on transport failure or abort. */
  protected async sh(argv: string[], context: Context, stdin?: Uint8Array, onStdout?: (d: Buffer) => void): Promise<Out> {
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    const code = await this.client.exec(this.sandbox, {
      command: argv,
      workdir: this.cwd,
      stdin,
      signal: context.abortSignal,
      timeoutSecs: 120,
      onStdout: (d) => (onStdout ? onStdout(d) : out.push(d)),
      onStderr: (d) => errs.push(d),
    });
    return { code, stdout: Buffer.concat(out), stderr: Buffer.concat(errs).toString() };
  }

  /** Like sh, but a thrown transport error becomes a FileError. */
  private async run(argv: string[], target: string, context: Context, stdin?: Uint8Array, onStdout?: (d: Buffer) => void): R<Out> {
    const early = aborted(context, target);
    if (early) return early;
    try {
      const out = await this.sh(argv, context, stdin, onStdout);
      return out.code === 0 ? ok(out) : err(fileError(out.stderr, target));
    } catch (error) {
      if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", target));
      return err(new FileError("unknown", `The sandbox could not run the file operation: ${error instanceof Error ? error.message : String(error)}`, target));
    }
  }

  private resolve(p: string): string {
    return path.posix.resolve(this.cwd, p);
  }

  // --- paths --------------------------------------------------------------------

  async absolutePath(p: string): R<string> {
    return ok(this.resolve(p));
  }

  async joinPath(parts: string[]): R<string> {
    return ok(path.posix.join(...parts));
  }

  async canonicalPath(p: string, context: Context): R<string> {
    const target = this.resolve(p);
    const r = await this.run(["realpath", "-e", "--", target], target, context);
    return r.ok ? ok(r.value.stdout.toString().replace(/\n$/, "")) : r;
  }

  // --- reading ------------------------------------------------------------------

  async readBinaryFile(p: string, context: Context): R<Uint8Array> {
    const target = this.resolve(p);
    const r = await this.run(["cat", "--", target], target, context);
    return r.ok ? ok(new Uint8Array(r.value.stdout)) : r;
  }

  async readTextFile(p: string, context: Context): R<string> {
    const r = await this.readBinaryFile(p, context);
    // Like fs.readFile(..., "utf8"): a byte-order mark stays in the text.
    return r.ok ? ok(new TextDecoder("utf-8", { ignoreBOM: true }).decode(r.value)) : r;
  }

  async openTextLineReader(p: string, context: Context): R<TextLineReader> {
    const target = this.resolve(p);
    const info = await this.fileInfo(target, context);
    if (!info.ok) return info;
    if (info.value.size > TEXT_LINE_LIMIT) return err(new FileError("invalid", `${target} is too large to read line by line`, target));
    const bytes = await this.readBinaryFile(target, context);
    if (!bytes.ok) return bytes;
    return ok(new BufferedLineReader(bytes.value));
  }

  async readTextLines(p: string, options: { maxLines?: number } | undefined, context: Context): R<string[]> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(p, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally {
      await opened.value.close(context);
    }
  }

  async openBinaryReader(p: string, options: { noFollow?: boolean } | undefined, context: Context): R<BinaryReader> {
    const target = this.resolve(p);
    if (options?.noFollow) {
      const link = await this.stat(target, false, context);
      if (!link.ok) return link;
      if (link.value.kind === "symlink") return err(new FileError("invalid", "Refusing to follow a symbolic link", target));
    }
    const info = await this.stat(target, true, context);
    if (!info.ok) return info;
    if (info.value.kind === "directory") return err(new FileError("is_directory", `${target}: Is a directory`, target));
    if (info.value.kind !== "file") return err(new FileError("invalid", "Not a regular file", target));
    return ok(new SandboxBinaryReader(this, target));
  }

  // --- writing ------------------------------------------------------------------

  private async put(p: string, content: string | Uint8Array, mode: "write" | "append", context: Context): R<void> {
    const target = this.resolve(p);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    for (let at = 0, first = true; first || at < bytes.length; first = false) {
      const piece = bytes.subarray(at, at + WRITE_CHUNK);
      const redirect = mode === "write" && at === 0 ? ">" : ">>";
      const r = await this.run(["sh", "-c", `mkdir -p -- "$(dirname -- "$1")" && cat ${redirect} "$1"`, "sh", target], target, context, piece);
      if (!r.ok) return r;
      at += piece.length;
      if (piece.length === 0) break;
    }
    return ok(undefined);
  }

  writeFile(p: string, content: string | Uint8Array, context: Context): R<void> {
    return this.put(p, content, "write", context);
  }

  appendFile(p: string, content: string | Uint8Array, context: Context): R<void> {
    return this.put(p, content, "append", context);
  }

  async truncateFile(p: string, size: number, context: Context): R<void> {
    const target = this.resolve(p);
    if (!Number.isSafeInteger(size) || size < 0) return err(new FileError("invalid", "File size must be a non-negative safe integer", target));
    const r = await this.run(["truncate", "-s", String(size), "--", target], target, context);
    return r.ok ? ok(undefined) : r;
  }

  async flushFile(p: string, context: Context): R<void> {
    const target = this.resolve(p);
    const r = await this.run(["sync", "--", target], target, context);
    return r.ok ? ok(undefined) : r;
  }

  async renameFile(from: string, to: string, context: Context): R<void> {
    const source = this.resolve(from);
    const r = await this.run(["mv", "--", source, this.resolve(to)], source, context);
    return r.ok ? ok(undefined) : r;
  }

  async createDir(p: string, options: { recursive?: boolean } | undefined, context: Context): R<void> {
    const target = this.resolve(p);
    const r = await this.run(["mkdir", ...(options?.recursive ?? true ? ["-p"] : []), "--", target], target, context);
    return r.ok ? ok(undefined) : r;
  }

  async remove(p: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): R<void> {
    const target = this.resolve(p);
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    const r = await this.run(["rm", ...(flags ? [`-${flags}`] : []), "--", target], target, context);
    return r.ok ? ok(undefined) : r;
  }

  // --- metadata -----------------------------------------------------------------

  /** `follow` resolves a final symlink (fstat); without it the link itself is described (lstat). */
  async stat(target: string, follow: boolean, context: Context): R<FileInfo> {
    const r = await this.run(["sh", "-c", STAT, "sh", ...(follow ? ["-L"] : []), target], target, context);
    if (!r.ok) return r;
    const [type = "", size = "0", mtime = "0"] = r.value.stdout.toString().split("\0");
    const kind = toKind(type);
    if (!kind) return err(new FileError("invalid", "Unsupported file type", target));
    return ok({ name: path.posix.basename(target), path: target, kind, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) });
  }

  async fileInfo(p: string, context: Context): R<FileInfo> {
    return this.stat(this.resolve(p), false, context);
  }

  async exists(p: string, context: Context): R<boolean> {
    const r = await this.fileInfo(p, context);
    if (r.ok) return ok(true);
    return r.error.code === "not_found" ? ok(false) : r;
  }

  async listDir(p: string, context: Context): R<FileInfo[]> {
    const target = this.resolve(p);
    const r = await this.run(["sh", "-c", LIST, "sh", target], target, context);
    if (!r.ok) return r;
    const fields = r.value.stdout.toString().split("\0");
    const entries: FileInfo[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const kind = toKind(fields[i + 1]!);
      if (kind) entries.push({ name: fields[i]!, path: path.posix.join(target, fields[i]!), kind, size: Number(fields[i + 2]), mtimeMs: Math.round(Number(fields[i + 3]) * 1000) });
    }
    return ok(entries);
  }

  async openDirReader(p: string, context: Context): R<DirReader> {
    const all = await this.listDir(p, context);
    if (!all.ok) return all;
    let next = 0;
    return ok({
      async next(maxEntries: number) {
        if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return err(new FileError("invalid", "maxEntries must be a positive safe integer"));
        const entries = all.value.slice(next, next + maxEntries);
        next += entries.length;
        return ok({ entries, done: next >= all.value.length });
      },
      async close() {},
    });
  }

  // --- temp files, watching -----------------------------------------------------

  async createTempDir(prefix: string | undefined, context: Context): R<string> {
    const r = await this.run(["mktemp", "-d", `/tmp/${safeName(prefix ?? "tmp-")}XXXXXX`], "/tmp", context);
    return r.ok ? ok(r.value.stdout.toString().trim()) : r;
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): R<string> {
    const r = await this.run(["mktemp", ...(options?.suffix ? [`--suffix=${safeName(options.suffix)}`] : []), `/tmp/${safeName(options?.prefix ?? "tmp-")}XXXXXX`], "/tmp", context);
    return r.ok ? ok(r.value.stdout.toString().trim()) : r;
  }

  async watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): R<FileWatcher> {
    return err(new FileError("not_supported", "Watching files is not supported in an OpenShell sandbox"));
  }

  /** Streams a file's bytes to `onChunk`, one command, bounded memory. */
  async stream(p: string, onChunk: (d: Buffer) => void, context: Context): R<void> {
    const target = this.resolve(p);
    const r = await this.run(["cat", "--", target], target, context, undefined, onChunk);
    return r.ok ? ok(undefined) : r;
  }

  /** `length` bytes from `offset`; fewer at the end of the file. */
  async readRange(target: string, offset: number, length: number, context: Context): R<Buffer> {
    const r = await this.run(["sh", "-c", `tail -c +"$2" -- "$1" | head -c "$3"`, "sh", target, String(offset + 1), String(length)], target, context);
    return r.ok ? ok(r.value.stdout) : r;
  }
}

const safeName = (s: string) => s.replace(/[^\w.-]/g, "_");

class BufferedLineReader implements TextLineReader {
  private decoder = new StreamDecoder();
  private text: string;
  private closed = false;

  constructor(bytes: Uint8Array) {
    this.text = this.decoder.decode(bytes) + this.decoder.decode();
  }

  async readLine(): Promise<Result<TextLine | undefined, FileError>> {
    if (this.closed) return err(new FileError("invalid", "Text line reader is closed"));
    if (this.text.length === 0) return ok(undefined);
    const newline = this.text.indexOf("\n");
    if (newline === -1) {
      const text = this.text;
      this.text = "";
      return ok({ text, terminated: false });
    }
    const text = this.text.slice(0, newline);
    this.text = this.text.slice(newline + 1);
    return ok({ text, terminated: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.text = "";
  }
}

class SandboxBinaryReader implements BinaryReader {
  private closed = false;
  private window: { start: number; bytes: Buffer } | null = null;

  constructor(
    private fs: SandboxFileSystem,
    private target: string,
  ) {}

  async info(context: Context): R<FileInfo> {
    if (this.closed) return err(new FileError("invalid", "Binary reader is closed", this.target));
    return this.fs.stat(this.target, true, context);
  }

  async read(offset: number, length: number, context: Context): R<Uint8Array> {
    if (this.closed) return err(new FileError("invalid", "Binary reader is closed", this.target));
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.target));
    }
    if (length === 0) return ok(new Uint8Array(0));
    const w = this.window;
    if (w && offset >= w.start && offset + length <= w.start + w.bytes.length) return ok(w.bytes.subarray(offset - w.start, offset - w.start + length));
    const fetched = await this.fs.readRange(this.target, offset, Math.max(length, READ_WINDOW), context);
    if (!fetched.ok) return fetched;
    this.window = { start: offset, bytes: fetched.value };
    return ok(fetched.value.subarray(0, Math.min(length, fetched.value.length)));
  }

  async scanLines(options: { startLine: number; endLine?: number }, context: Context): R<LineScan> {
    if (this.closed) return err(new FileError("invalid", "Binary reader is closed", this.target));
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError("invalid", "Invalid line range", this.target));
    }
    const streamed = await this.fs.stream(this.target, (chunk) => scanner.push(chunk), context);
    return streamed.ok ? ok(scanner.finish()) : streamed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.window = null;
  }
}
