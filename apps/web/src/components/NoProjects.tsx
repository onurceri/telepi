import { useState } from "react";

const COMMAND = "pnpm telepi project add <path-or-git-url>";

/** First run: telepi has no projects until one is added on the computer that runs the server. */
export function NoProjects({ title = "No projects yet." }: { title?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard can be blocked; the command stays selectable */
    }
  };
  return (
    <div className="empty">
      <b>{title}</b>
      <span>Add a project on your computer, then it shows up here:</span>
      <pre className="pre empty-cmd">{COMMAND}</pre>
      <span>Use a folder with a git repository, or a git URL. Then start a task from this phone.</span>
      <button type="button" className="btn" onClick={copy}>{copied ? "Copied" : "Copy command"}</button>
    </div>
  );
}
