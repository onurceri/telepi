// A small, safe Markdown subset for text the agent wrote. It builds React elements from a parsed structure:
// no HTML passthrough, no dangerouslySetInnerHTML, and links are shown as text with the URL visible, never clickable.
// Supported: paragraphs, line breaks, **bold**, *italic* / _italic_, `code`, fenced code blocks, lists (one nested level),
// headings (as bold lines), links. Anything else stays literal text. Incomplete input (streaming) renders sensibly:
// an unclosed fence is a code block so far, an unclosed ** or ` stays literal until its closing part arrives.
import { Fragment, type ReactNode } from "react";

type Block =
  | { t: "p"; lines: string[] }
  | { t: "h"; text: string }
  | { t: "code"; text: string }
  | { t: "list"; ordered: boolean; items: { text: string; children: { ordered: boolean; items: string[] } | null }[] };

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || ITEM.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence, if it has arrived
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { blocks.push({ t: "h", text: h[1]! }); i++; continue; }
    const first = ITEM.exec(line);
    if (first) {
      const list: Extract<Block, { t: "list" }> = { t: "list", ordered: /\d/.test(first[2]!), items: [] };
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (m) {
          const nested = m[1]!.replace(/\t/g, "  ").length >= 2 && list.items.length > 0;
          if (nested) {
            const parent = list.items[list.items.length - 1]!;
            parent.children ??= { ordered: /\d/.test(m[2]!), items: [] };
            parent.children.items.push(m[3]!);
          } else {
            list.items.push({ text: m[3]!, children: null });
          }
          i++;
        } else if (lines[i]!.trim() !== "" && /^\s{2,}\S/.test(lines[i]!) && list.items.length > 0) {
          const last = list.items[list.items.length - 1]!; // a wrapped continuation line
          if (last.children) last.children.items[last.children.items.length - 1] += "\n" + lines[i]!.trim();
          else last.text += "\n" + lines[i]!.trim();
          i++;
        } else break;
      }
      blocks.push(list);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (para.length === 0 || !startsBlock(lines[i]!))) para.push(lines[i++]!);
    blocks.push({ t: "p", lines: para });
  }
  return blocks;
}

const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;
const BARE_URL = /^https?:\/\/[^\s<>]+/;

function Url({ children }: { children: string }) {
  // Not an anchor on purpose: agent-written links must not be one tap from opening.
  return <span className="md-url">{children}</span>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = "";
  let k = 0;
  const flush = () => { if (plain) { out.push(plain); plain = ""; } };
  const push = (n: ReactNode) => { flush(); out.push(<Fragment key={k++}>{n}</Fragment>); };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) { push(<code className="md-code">{text.slice(i + 1, end)}</code>); i = end + 1; continue; }
    } else if (rest.startsWith("**")) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2 && text[i + 2] !== " ") { push(<strong>{inline(text.slice(i + 2, end))}</strong>); i = end + 2; continue; }
    } else if ((c === "*" || c === "_") && text[i + 1] !== " " && text[i + 1] !== c && (c === "*" || !/\w/.test(text[i - 1] ?? " "))) {
      let end = text.indexOf(c, i + 1);
      while (end > 0 && (text[end - 1] === " " || (c === "_" && /\w/.test(text[end + 1] ?? " ")))) end = text.indexOf(c, end + 1);
      if (end > i + 1) { push(<em>{inline(text.slice(i + 1, end))}</em>); i = end + 1; continue; }
    } else if (c === "[") {
      const m = LINK.exec(rest);
      if (m) {
        push(m[1] === m[2] ? <Url>{m[2]!}</Url> : <>{inline(m[1]!)} (<Url>{m[2]!}</Url>)</>);
        i += m[0].length;
        continue;
      }
    } else if (c === "h" && !/\w/.test(text[i - 1] ?? " ")) {
      const m = BARE_URL.exec(rest);
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]]+$/, "");
        push(<Url>{url}</Url>);
        i += url.length;
        continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

/** Inline formatting only, for one-line places such as buttons and list rows. Line breaks are kept. */
export function MarkdownInline({ text }: { text: string }) {
  const parts = text.split("\n");
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{i > 0 && <br />}{inline(p)}</Fragment>
      ))}
    </>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return <>{lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l.trim())}</Fragment>)}</>;
}

/** Block Markdown: paragraphs, lists, headings (bold lines), fenced code. */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`md ${className}`}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p": return <p key={i}><Lines lines={b.lines} /></p>;
          case "h": return <p key={i} className="md-h">{inline(b.text)}</p>;
          case "code": return <pre key={i} className="pre wrap md-pre" tabIndex={0}>{b.text.split("\n").map((l, j) => <span key={j} className="ln" style={{ paddingLeft: `${l.length - l.trimStart().length + 2}ch` }}>{l.trim() === "" ? " " : l.trimStart()}</span>)}</pre>;
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i} className="md-list">
                {b.items.map((it, j) => {
                  const Sub = it.children?.ordered ? "ol" : "ul";
                  return (
                    <li key={j}>
                      <MarkdownInline text={it.text} />
                      {it.children && <Sub className="md-list">{it.children.items.map((c, n) => <li key={n}><MarkdownInline text={c} /></li>)}</Sub>}
                    </li>
                  );
                })}
              </L>
            );
          }
        }
      })}
    </div>
  );
}

/** The text without Markdown markers, for list rows where it is shown as one plain line. */
export function plainText(src: string): string {
  return src
    .replace(/```[^\n]*\n?/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(^|\s)[*_]([^\s*_][^*_\n]*?)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}
