#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-local-span-home-'))
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
const REFUSAL_TAIL = '% of the file — name the smallest unique span, or rewrite the file with Write'

type Ctx = { readFileState: Map<string, unknown> }
function makeContext(model: string): Ctx {
  return {
    readFileState: new Map<string, unknown>(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    options: { mainLoopModel: model, tools: [], commands: [], mcpClients: [], isNonInteractiveSession: true, verbose: false, agentDefinitions: { activeAgents: [] } },
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
const menuFile = (): string => {
  const rows = Array.from({ length: 108 }, (_, i) => `    <li class="menu-row" data-index="${i + 1}">Row ${i + 1} — a menu entry with its label and hint</li>`)
  return `<!doctype html>\n<html>\n<body>\n  <ul id="menu">\n${rows.join('\n')}\n  </ul>\n</body>\n</html>\n`
}
const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8')

section('the lane: the fixture model is a discovered local record; the cloud id is not')
{
  check('local record present', localRecordFor(LOCAL_MODEL) !== undefined)
  check('no record for the cloud id or the unlisted local id', localRecordFor(CLOUD_MODEL) === undefined && localRecordFor(UNLISTED_LOCAL) === undefined)
}

section('1 · a local record: an old_string that is the whole 9.9 KB file is refused before any write, with the tool\'s words')
{
  const file = join(fixtures, 'csgo-menu.html')
  const content = menuFile()
  writeFileSync(file, content)
  check(`the fixture file is about 9.9 KB (${bytesOf(content)} bytes)`, bytesOf(content) > 9_000 && bytesOf(content) < 11_000)
  const ctx = makeContext(LOCAL_MODEL)
  primeRead(ctx, file)
  const whole = await edit({ file_path: file, old_string: content, new_string: content.replace('Row 7 —', 'Row 7 (renamed) —') }, ctx)
  check('refused', !whole.ok, messageOf(whole))
  check('with the words: "old_string is 100% of the file — name the smallest unique span, or rewrite the file with Write"', !whole.ok && whole.message === `old_string is 100${REFUSAL_TAIL}`, messageOf(whole))
  check('nothing was written', readFileSync(file, 'utf8') === content)
  writeFileSync(file, content)
  const again = makeContext(LOCAL_MODEL)
  primeRead(again, file)
  const sixty = content.slice(0, Math.floor(content.length * 0.6))
  const most = await edit({ file_path: file, old_string: sixty, new_string: sixty.replace('Row 7 —', 'Row 7 (renamed) —') }, again)
  check('a 60% span is refused too, naming its share', !most.ok && most.message === `old_string is 60${REFUSAL_TAIL}`, messageOf(most))
  check('still nothing written', readFileSync(file, 'utf8') === content)
}

section('2 · a local record: a 20% span passes and lands')
{
  const file = join(fixtures, 'menu-small-span.html')
  const content = menuFile()
  writeFileSync(file, content)
  const ctx = makeContext(LOCAL_MODEL)
  primeRead(ctx, file)
  const lines = content.split('\n')
  const span = lines.slice(10, 32).join('\n')
  check(`the span is about a fifth of the file (${Math.round((100 * bytesOf(span)) / bytesOf(content))}%)`, bytesOf(span) * 4 < bytesOf(content) && bytesOf(span) * 6 > bytesOf(content))
  const r = await edit({ file_path: file, old_string: span, new_string: span.replace('Row 20 —', 'Row 20 (renamed) —') }, ctx)
  check('passes', r.ok, messageOf(r))
  check('the edit landed', readFileSync(file, 'utf8').includes('Row 20 (renamed) —'))
}

section('3 · the boundary is "more than half" by bytes: exactly half passes, one byte over is refused')
{
  const file = join(fixtures, 'hundred.txt')
  const content = 'a'.repeat(50) + '\n' + 'b'.repeat(49)
  writeFileSync(file, content)
  check('the file is 100 bytes', bytesOf(content) === 100)
  const ctx = makeContext(LOCAL_MODEL)
  primeRead(ctx, file)
  const half = await validate({ file_path: file, old_string: 'a'.repeat(50), new_string: 'c'.repeat(50) }, ctx)
  check('50 of 100 bytes passes', half.ok, messageOf(half))
  const over = await validate({ file_path: file, old_string: 'a'.repeat(50) + '\n', new_string: 'c'.repeat(50) + '\n' }, ctx)
  check('51 of 100 bytes is refused as 51%', !over.ok && over.message === `old_string is 51${REFUSAL_TAIL}`, messageOf(over))
}

section('4 · a cloud model: a whole-file old_string passes as today')
{
  const file = join(fixtures, 'menu-cloud.html')
  const content = menuFile()
  writeFileSync(file, content)
  const ctx = makeContext(CLOUD_MODEL)
  primeRead(ctx, file)
  const r = await edit({ file_path: file, old_string: content, new_string: content.replace('Row 7 —', 'Row 7 (renamed) —') }, ctx)
  check('passes and lands', r.ok && readFileSync(file, 'utf8').includes('Row 7 (renamed) —'), messageOf(r))
}

section('5 · the record decides: a local id no server lists keeps the guard off')
{
  const file = join(fixtures, 'menu-unlisted.html')
  const content = menuFile()
  writeFileSync(file, content)
  const ctx = makeContext(UNLISTED_LOCAL)
  primeRead(ctx, file)
  const r = await validate({ file_path: file, old_string: content, new_string: content.replace('Row 7 —', 'Row 7 (renamed) —') }, ctx)
  check('passes validation (no record, no guard)', r.ok, messageOf(r))
}

section('6 · the description: one sentence on the local lane, the cloud description unchanged')
{
  const promptFor = async (model: string): Promise<string> =>
    (FileEditTool as { prompt: Function }).prompt({ tools: [], model, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [] })
  const local = await promptFor(LOCAL_MODEL)
  const cloud = await promptFor(CLOUD_MODEL)
  const sentence = local.split('\n').find(line => line.includes('half the file'))
  check('the local description carries one sentence about the half-the-file refusal', sentence !== undefined, local.slice(-300))
  check('the sentence names the span and the Write road', sentence !== undefined && sentence.includes('smallest unique span') && sentence.includes('Write'), sentence ?? '')
  check('the sentence says it is refused before any write', sentence !== undefined && /before any write/.test(sentence), sentence ?? '')
  check('the cloud description carries no such sentence', !cloud.includes('half the file'))
  check('the local description is the cloud description plus that one line', local.split('\n').filter(line => line !== sentence).join('\n') === cloud)
}

vllm.server.close()
clearTimeout(guard)
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-edit-local-span-guard: ALL GREEN' : `prove-edit-local-span-guard: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
