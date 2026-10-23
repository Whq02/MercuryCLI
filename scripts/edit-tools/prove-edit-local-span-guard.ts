#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-local-span-home-'))
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
for (const k of ['MERCURY_EDIT_HUNKS', 'MERCURY_CHANGE_RECEIPTS', 'MERCURY_EDIT_STALE_RECOVERY', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'NODE_ENV']) {
  delete process.env[k]
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the local span guard proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string }> {
  return new Promise(resolvePromise => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePromise({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}
const MODEL_ID = 'Qwen/Qwen3-32B'
const VLLM_MODELS = { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 1, owned_by: 'vllm', root: '/models/Qwen3-32B', parent: null, max_model_len: 40960, permission: [] }] }
const vllm = await serve((req, _body, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(VLLM_MODELS))
    return true
  }
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `vllm=${vllm.root}`

const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
await refreshLocalDiscovery({ force: true })

const LOCAL_MODEL = `local/${MODEL_ID}`
const CLOUD_MODEL = 'claude-fable-5-1'
const UNLISTED_LOCAL = 'local/nowhere:latest'
const fixtures = mkdtempSync(join(tmpdir(), 'edit-local-span-fixture-'))

type Ctx = { readFileState: Map<string, unknown> }
function makeContext(model: string): Ctx {
  return {
    readFileState: new Map<string, unknown>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    options: { engineModel: model, tools: [], commands: [], mcpClients: [], isNonInteractiveSession: true, verbose: false, agentDefinitions: { activeAgents: [] } },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as never as Ctx
}
function primeRead(ctx: Ctx, path: string): void {
  ctx.readFileState.set(path, { content: readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), timestamp: Date.now() + 60_000, offset: undefined, limit: undefined })
}
async function validate(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true } | { ok: false; message: string }> {
  const verdict = await (FileEditTool as { validateInput: Function }).validateInput(input, ctx)
  return verdict.result === false ? { ok: false, message: String(verdict.message) } : { ok: true }
}
async function edit(input: Record<string, unknown>, ctx: Ctx): Promise<{ ok: true } | { ok: false; message: string }> {
  const verdict = await validate(input, ctx)
  if (!verdict.ok) return verdict
  try {
    await (FileEditTool as { call: Function }).call(input, ctx, null, { uuid: '00000000-0000-0000-0000-000000000003', message: { id: 'msg_fixture' } })
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
const messageOf = (v: { ok: boolean; message?: string }): string => (v.ok ? '(passed)' : v.message ?? '')
check('local fixture record is present', localRecordFor(LOCAL_MODEL) !== undefined)
for (const model of [LOCAL_MODEL, CLOUD_MODEL]) {
  for (const count of [1, 20]) {
    const file = join(fixtures, `${model === LOCAL_MODEL ? 'local' : 'hosted'}-${count}.txt`)
    const content = Array.from({ length: count }, (_, i) => `line ${i}`).join('\n')
    writeFileSync(file, content)
    const ctx = makeContext(model)
    primeRead(ctx, file)
    const r = await edit({ file_path: file, old_string: content, new_string: content.replace('line 0', 'changed 0') }, ctx)
    check(`${model}: ${count}-line exact replacement lands`, r.ok && readFileSync(file, 'utf8').startsWith('changed 0'), messageOf(r))
  }
  for (const gate of ['unread', 'stale', 'ambiguous']) {
    const file = join(fixtures, `${model === LOCAL_MODEL ? 'local' : 'hosted'}-${gate}.txt`)
    const content = 'repeat\nrepeat\ntail\n'
    writeFileSync(file, content)
    const ctx = makeContext(model)
    if (gate !== 'unread') primeRead(ctx, file)
    if (gate === 'stale') {
      (ctx.readFileState.get(file) as { timestamp: number }).timestamp = 0
      writeFileSync(file, content + 'new content\n')
    }
    const before = readFileSync(file, 'utf8')
    const r = await edit({ file_path: file, old_string: gate === 'ambiguous' ? 'repeat' : 'tail', new_string: 'updated' }, ctx)
    check(`${model}: ${gate} still refuses`, !r.ok, messageOf(r))
    check(`${model}: ${gate} writes nothing`, readFileSync(file, 'utf8') === before)
  }
}
const promptFor = async (model: string): Promise<string> =>
  (FileEditTool as { prompt: Function }).prompt({ tools: [], model, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [] })
check('local and hosted descriptions are identical', await promptFor(LOCAL_MODEL) === await promptFor(CLOUD_MODEL))
vllm.server.close()
clearTimeout(guard)
rmSync(fixtures, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
