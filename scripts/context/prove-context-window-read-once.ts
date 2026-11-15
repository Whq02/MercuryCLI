#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'HF_TOKEN', 'MERCURY_MODEL', 'MERCURY_BARE', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_AUTO_COMPACT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-ctx-window-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const LISTED = 1_048_576
let asked = 0
let probes = 0
let firstAnswerMs = 0
const server = http.createServer((req, res) => {
  if (!(req.url ?? '').startsWith('/api/v1/models')) {
    probes++
    res.writeHead(404).end()
    return
  }
  const wait = asked++ === 0 ? firstAnswerMs : 0
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'stealth/ox-alpha', name: 'Ox Alpha', context_length: LISTED }], total_count: 1, links: { next: null } }))
  }, wait)
})
await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
const port = (server.address() as { port: number }).port
process.env.OPENROUTER_API_KEY = 'sk-or-fixture'
process.env.MERCURY_OPENROUTER_API_BASE = `http://127.0.0.1:${port}/api/v1`
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=http://127.0.0.1:${port}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { analyzeContextUsage } = await import('../../src/utils/analyzeContext.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const openrouter = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')

const CARRIER = 'openrouter/stealth/ox-alpha'
const agents = { activeAgents: [], allAgents: [] }
const messages = [createUserMessage({ content: 'the operator asks what the context holds' })]
type View = Awaited<ReturnType<typeof analyzeContextUsage>>
let heldTools = 0
async function view(model: string, midway?: () => Promise<unknown>): Promise<{ data?: View; thrown?: string; ms: number; midway: number }> {
  const began = Date.now()
  let ran = 0
  const reached = (): number => ran
  const held = {
    ...FileReadTool,
    name: `HeldRead${++heldTools}`,
    prompt: async (): Promise<string> => {
      if (midway && ran++ === 0) await midway()
      return 'Reads one file.'
    },
  }
  try {
    const data = await analyzeContextUsage(
      messages as never,
      model,
      async () => getEmptyToolPermissionContext(),
      [held] as never,
      agents,
      120,
      { options: {} } as never,
    )
    return { data, ms: Date.now() - began, midway: reached() }
  } catch (error) {
    return { thrown: String((error as Error)?.message ?? error), ms: Date.now() - began, midway: reached() }
  }
}
const reserveOf = (data: View | undefined) => data?.categories.find(c => c.name === 'Autocompact buffer' || c.name === 'Compact buffer')
const sumOf = (data: View): number => data.categories.filter(c => !c.isDeferred).reduce((total, c) => total + c.tokens, 0)
const listArrives = (): Promise<unknown> => openrouter.refreshOpenrouterCatalogue('env', { force: true })

console.log('/context reads its window once it is known, and no row of it is ever negative')

section('§1 the model list arrives while the view is being made')
{
  openrouter.__resetOpenrouterCatalogueForTest()
  asked = 0
  firstAnswerMs = 0
  const made = await view(CARRIER, listArrives)
  check('the fixture reaches into the making of the view: the list is asked for while the view is being made', made.midway > 0, String(made.midway))
  check('the view is made (RED on the parent: the window was read before the list and the fold line after it, the reserve came out negative and the grid threw)', made.thrown === undefined, String(made.thrown))
  check('…on the window the list states', made.data?.maxTokens === LISTED, String(made.data?.maxTokens))
  const reserve = reserveOf(made.data)
  check('…with a reserve that is a share of that window', reserve !== undefined && reserve.tokens > 0 && reserve.tokens < LISTED, JSON.stringify(reserve))
  check('…and rows that add up to it', made.data !== undefined && sumOf(made.data) === LISTED, made.data ? `${sumOf(made.data)} vs ${LISTED}` : 'no view')
}

section('§2 the list answers later than the view waits for it, and arrives midway')
{
  openrouter.__resetOpenrouterCatalogueForTest()
  asked = 0
  firstAnswerMs = 4000
  const made = await view(CARRIER, listArrives)
  check('the view is made all the same (RED on the parent)', made.thrown === undefined, String(made.thrown))
  const reserve = reserveOf(made.data)
  check('no row of it is negative: the reserve is nothing where the fold line read a larger window than the view did', made.data !== undefined && made.data.categories.every(c => c.tokens >= 0) && reserve !== undefined && reserve.tokens >= 0, JSON.stringify(made.data?.categories.map(c => [c.name, c.tokens])))
  check('it waited for the list no longer than its bound of three seconds', made.ms >= 2500 && made.ms < 9000, `${made.ms} ms`)
}

section('§3 controls')
{
  openrouter.__resetOpenrouterCatalogueForTest()
  asked = 0
  firstAnswerMs = 0
  await listArrives()
  const before = asked
  const warm = await view(CARRIER)
  const reserve = reserveOf(warm.data)
  check('a list already read: the same window and a positive reserve, and the view asks for no list (holds on the parent)', warm.thrown === undefined && warm.data?.maxTokens === LISTED && reserve !== undefined && reserve.tokens > 0 && asked === before, `${warm.thrown} ${warm.data?.maxTokens} asked ${asked - before}`)
  const plain = await view('claude-fable-5-1')
  check('a model whose window no list states is not kept waiting: the view asks for no list and answers at once (holds on the parent)', plain.thrown === undefined && asked === before && plain.ms < 1500 && (reserveOf(plain.data)?.tokens ?? -1) >= 0, `${plain.thrown} ${plain.ms} ms asked ${asked - before}`)
  const probed = probes
  const local = await view('local/held-fixture:1b')
  check('a local model is left as it was: the view asks its server nothing, so it decides no window for the session (holds on the parent)', local.thrown === undefined && probes === probed && asked === before, `${local.thrown} probes ${probes - probed} asked ${asked - before}`)
}

await new Promise<void>(done => server.close(() => done()))
console.log(`\n${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
