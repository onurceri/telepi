// What an approved network destination lets the sandbox do. The model in one sentence: approving a site lets the agent
// READ from it; sending data to it asks again.
//
//  - Web ports (HTTP and HTTPS): the supervisor terminates TLS, reads every request and lets through only reads: GET,
//    HEAD, OPTIONS, and git's read protocol (the POST that fetches and clones). Any other request (a POST to an API, a
//    git push, an upload) is refused with a 403; the supervisor logs it and telepi turns it into a "send data" card.
//    Approving that adds a rule for that one method and path (see sendPath).
//  - Every other port is not HTTP, so telepi cannot tell a read from a write. It stays open for any bytes once the user
//    approves it, and the card says so.
// Verified against OpenShell 0.1.3 in deploy/openshell/README.md ("Egress, reads and writes").
import type { HttpAllow, NetworkEndpointSpec } from "./openshell/client";

/** Ports whose traffic is HTTP, so requests can be inspected. */
const WEB_PORTS = new Set([80, 443, 8080, 8443]);
export const isWebPort = (port: number) => WEB_PORTS.has(port);

/** The reads: ordinary fetches, plus the POST that git clone and fetch use to download (never git-receive-pack). */
export const READ_RULES: HttpAllow[] = [
  { method: "GET", path: "/**" },
  { method: "HEAD", path: "/**" },
  { method: "OPTIONS", path: "/**" },
  { method: "POST", path: "/**/git-upload-pack" },
];

/** A request the supervisor refused on an approved host: it would send data. */
export interface Send {
  host: string;
  port: number;
  method: string;
  /** The path pattern a rule would carry (see sendPath), which is also what the card shows. */
  path: string;
}

/** "host:port" for a read grant, as stored in a project's allowed actions ("network:host:port"). */
export const readId = (host: string, port: number) => `network:${host}:${port}`;
/** Project-level allow id for one send: "network.send:POST:host:443/path". */
export const sendId = (s: Send) => `network.send:${s.method}:${s.host}:${s.port}${s.path}`;

export function parseSendId(id: string): Send | null {
  const m = /^network\.send:([A-Z]+):([^:/]+):(\d+)(\/.*)$/.exec(id);
  return m ? { method: m[1]!, host: m[2]!, port: Number(m[3]), path: m[4]! } : null;
}

/** The read grants in a project's allowed actions, as "host:port". */
export const readGrants = (actions: string[]) => actions.filter((a) => a.startsWith("network:")).map((a) => a.slice("network:".length));
/** The send grants in a project's allowed actions. */
export const sendGrants = (actions: string[]) => actions.map(parseSendId).filter((s): s is Send => s !== null);

export const sendKey = (s: { method: string; host: string; port: number; path: string }) => `${s.method} ${s.host}:${s.port}${s.path}`;

/**
 * The path pattern for a rule that lets one kind of request through. As narrow as is useful: the exact path, without
 * the query, except that a segment made only of digits (an issue number, a run id) becomes "*" so the same call on
 * the next number is not asked about again. Nothing else is widened: not the repository, not the API version.
 */
export function sendPath(rawPath: string): string {
  const path = rawPath.split(/[?#]/)[0] || "/";
  return path.split("/").map((seg) => (/^\d+$/.test(seg) ? "*" : seg)).join("/");
}

/** A git push is a POST to <repo>.git/git-receive-pack. */
export const isGitPush = (path: string) => /\/git-receive-pack$/.test(path);

/** "host" for the default web ports, "host:port" otherwise. */
export const hostLabel = (host: string, port: number) => (port === 443 || port === 80 ? host : `${host}:${port}`);

/** One sentence for a card: what the agent is trying to do. */
export function describeSend(s: Send): string {
  const where = hostLabel(s.host, s.port);
  if (isGitPush(s.path)) return `push code to ${where}${s.path.replace(/\/git-receive-pack$/, "")}`;
  return `send data to ${where}`;
}

/**
 * The endpoints a sandbox needs for a set of grants: reads for every host, and the sends the project allowed, merged
 * into the same endpoint. Non-web ports are plain.
 */
export function endpointsFor(reads: { host: string; port: number }[], sends: Send[]): NetworkEndpointSpec[] {
  const out = new Map<string, NetworkEndpointSpec>();
  const get = (host: string, port: number) => {
    const k = `${host}:${port}`;
    let e = out.get(k);
    if (!e) out.set(k, (e = isWebPort(port) ? { host, port, http: [] } : { host, port }));
    return e;
  };
  for (const r of reads) {
    const e = get(r.host, r.port);
    if (e.http) e.http.push(...READ_RULES);
  }
  for (const s of sends) get(s.host, s.port).http?.push({ method: s.method, path: s.path });
  return [...out.values()];
}
