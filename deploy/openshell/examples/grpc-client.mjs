// Spike client: talks to the OpenShell gateway with plain gRPC (proto-loader, protos from the v0.1.3 tag).
// Run (no host install):  see README "Driving it from code".
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

const GATEWAY = process.env.OPENSHELL_GATEWAY_ENDPOINT ?? 'gateway:8080'
const PROTO_DIR = process.env.PROTO_DIR ?? '/work/proto'
const MOUNT_SRC = process.env.MOUNT_SRC // absolute path under OPENSHELL_WORKSPACES, same on gateway + docker host
const IMAGE = process.env.IMAGE ?? 'node:22-bookworm'
const NAME = process.env.SANDBOX ?? 'grpc-demo'

const def = protoLoader.loadSync('openshell.proto', {
  includeDirs: [PROTO_DIR], keepCase: true, longs: String, enums: String, defaults: false, oneofs: true,
})
const pkg = grpc.loadPackageDefinition(def)
const client = new pkg.openshell.v1.OpenShell(GATEWAY, grpc.credentials.createInsecure())
const ws = { workspace: 'default' }
const call = (m, req) => new Promise((res, rej) => client[m](req, (e, r) => (e ? rej(e) : res(r))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** google.protobuf.Struct wire shape for proto-loader (plain JSON -> {fields:{...}}). */
const toValue = (v) => v === null ? { nullValue: 0 } : Array.isArray(v) ? { listValue: { values: v.map(toValue) } }
  : typeof v === 'object' ? { structValue: toStruct(v) } : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'boolean' ? { boolValue: v } : { numberValue: v }
const toStruct = (o) => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toValue(v)])) })
const t0 = Date.now(); const lap = (s) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${s}`)

/** Exec: returns { stdout, stderr, exitCode } as separate values. */
function exec(command, { timeoutSecs = 0, workdir = '', env = {}, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const out = [], err = []
    const req = { workspace_scope: ws, sandbox: NAME, command, workdir, environment: env, no_login_shell: true }
    if (timeoutSecs) req.execution_timeout = { seconds: String(timeoutSecs), nanos: 0 }
    if (stdin) req.stdin = Buffer.from(stdin)
    const s = client.ExecSandbox(req)
    let exitCode = null
    s.on('data', (ev) => {
      if (ev.stdout) out.push(ev.stdout.data)
      else if (ev.stderr) err.push(ev.stderr.data)
      else if (ev.exit) exitCode = ev.exit.exit_code ?? 0 // proto3: 0 is omitted on the wire
    })
    s.on('error', reject)
    s.on('end', () => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), exitCode }))
  })
}

const health = await call('Health', {}); lap(`Health: ${JSON.stringify(health)}`)

const template = { image: IMAGE }
if (MOUNT_SRC) template.driver_config = toStruct({ docker: { mounts: [{ type: 'bind', source: MOUNT_SRC, target: '/workspace', read_only: false }] } })
await call('CreateSandbox', {
  workspace_scope: ws, name: NAME,
  spec: {
    template, command: ['sleep', 'infinity'],
    policy: { version: 1,
      filesystem: { include_workdir: true, read_only: ['/bin', '/usr', '/lib', '/proc', '/dev/urandom', '/etc', '/var/log'], read_write: ['/tmp', '/dev/null', '/workspace'] },
      landlock: { compatibility: 'hard_requirement' } },
  },
})
lap('CreateSandbox returned')
for (;;) {
  const r = await call('GetSandbox', { workspace_scope: ws, name: NAME })
  const p = r.sandbox.status?.phase
  if (p === 'SANDBOX_PHASE_READY') break
  if (p === 'SANDBOX_PHASE_ERROR') throw new Error(JSON.stringify(r.sandbox.status.conditions))
  await sleep(200)
}
lap('sandbox READY')

let r = await exec(['node', '-e', 'console.log("to-stdout");console.error("to-stderr");process.exit(7)'])
lap(`exec -> ${JSON.stringify(r)}`)
r = await exec(['sleep', '10'], { timeoutSecs: 2 }); lap(`exec timeout -> ${JSON.stringify(r)}`)
r = await exec(['tee', '/workspace/written-by-grpc.txt'], { stdin: 'hello via stdin\n' }); lap(`write file via exec stdin -> ${JSON.stringify(r)}`)
r = await exec(['cat', '/workspace/written-by-grpc.txt']); lap(`read file via exec -> ${JSON.stringify(r)}`)

r = await exec(['curl', '-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com']); lap(`curl before approval -> ${JSON.stringify(r)}`)
// Denials are flushed to the gateway asynchronously (seconds), so poll the draft inbox.
let draft
for (let i = 0; i < 60; i++) {
  draft = await call('GetDraftPolicy', { workspace_scope: ws, sandbox: NAME, status_filter: 'pending' })
  if (draft.chunks?.length) break
  await sleep(500)
}
lap(`pending chunks: ${JSON.stringify((draft.chunks ?? []).map((c) => ({ id: c.id, status: c.status, rule: c.rule_name, binary: c.binary, rationale: c.rationale, endpoints: c.proposed_rule?.endpoints?.map((e) => `${e.host}:${e.port}`) })))}`)
const chunk = (draft.chunks ?? []).find((c) => c.binary.endsWith('curl'))
const ap = await call('ApproveDraftChunk', { workspace_scope: ws, sandbox: NAME, chunk_id: chunk.id, review_token: chunk.review_token })
lap(`ApproveDraftChunk -> ${JSON.stringify(ap)}`)
for (let i = 0; i < 30; i++) {
  r = await exec(['curl', '-sS', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com'])
  if (r.exitCode === 0) break
  await sleep(500)
}
lap(`curl after approval (policy v${ap.policy_version}) -> ${JSON.stringify(r)}`)

const del = await call('DeleteSandbox', { workspace_scope: ws, name: NAME }); lap(`DeleteSandbox -> ${JSON.stringify(del)}`)
