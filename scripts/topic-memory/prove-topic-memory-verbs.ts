#!/usr/bin/env bun
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const memoryDir = mkdtempSync(join(tmpdir(), 'mneme-verbs-mem-'))
process.env.MERCURY_CONFIG_DIR = memoryDir
process.env.MERCURY_COORDINATION_MCP = '1'

const { createMercuryServer } = await import('../../src/integrations/mcp/mercuryServer.ts')
const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client')

let failures = 0
const check = (label: string, cond: boolean, detail = '', fix = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && fix ? ' — fix: ' + fix : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

async function connectedClient(): Promise<{ client: InstanceType<typeof Client>; close: () => Promise<void> }> {
  const server = await createMercuryServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mneme-proof', version: '0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, close: async () => { await client.close(); await server.close() } }
}

const TOOLS = ['Retain', 'Recall', 'Reflect', 'Correct']

section('§1 the mercury server carries no memory verb (real tools/list)')
{
  const { client, close } = await connectedClient()
  const names = (await client.listTools()).tools.map(t => t.name)
  check('no memory verb in the catalog', names.every(n => !n.startsWith('mneme')), names.filter(n => n.startsWith('mneme')).join(','), 'remove the memory verbs from the tool list that createMercuryServer in src/integrations/mcp/mercuryServer.ts registers; memory verbs belong in src/tools/kit/toolList.ts')
  check('the lease verbs and render_tui still present', names.includes('lease_take') && names.includes('lease_list') && names.includes('render_tui'), '', 'src/integrations/mcp/mercuryServer.ts must still register lease_take, lease_list and render_tui')
  await close()
}

section('§2 the four tools, with nothing set, round-trip through the isolated home')
{
  const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
  const names = getAllBaseTools().map(t => t.name)
  check('all four tools in the base roster', TOOLS.every(t => names.includes(t)), names.filter(n => TOOLS.includes(n)).join(','), 'getAllBaseTools in src/tools/kit/toolList.ts must list RetainTool, RecallTool, ReflectTool and CorrectTool when memoryVerbsEnabled() (src/sessions/mneme/memoryVerbs.ts) is true')
  const { RetainTool, RecallTool } = await import('../../src/tools/memory/MemoryTools.ts')
  const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.ts')
  const { maybeConsolidate } = await import('../../src/sessions/mneme/mnemeConsolidate.ts')
  const { retainItems, recallQuery } = await import('../../src/sessions/mneme/memoryVerbs.ts')
  const stored = retainItems([{ content: 'the verbs round-trip through the real tool roster', topic: 'tool surface' }], { session: 'proof' })
  check('Retain stores', stored[0]?.status === 'stored', JSON.stringify(stored), 'retainItems in src/sessions/mneme/memoryVerbs.ts must store an ordinary item; the reason is in the outcome shown')
  const libDir = mnemeLibraryDir()
  check('the row landed in the ISOLATED home', libDir.startsWith(memoryDir) && existsSync(join(libDir, 'current.jsonl')), libDir, 'mnemeLibraryDir in src/sessions/mneme/mnemeGates.ts must resolve under MERCURY_CONFIG_DIR, and retainItems must write current.jsonl there')
  const { pendingRows } = await import('../../src/sessions/mneme/mnemeBuffer.ts')
  const everyField = RetainTool.inputSchema.parse({ items: [{ content: 'a fact from a model that fills every optional field', context: '', topic: '', pin: false, replaces: '' }] })
  const asked = { messages: [{ type: 'user', uuid: 'verbs-ask', timestamp: '2026-10-19T09:00:00.000Z', message: { role: 'user', content: 'remember: a fact from a model that fills every optional field' } }] }
  const filled = (await RetainTool.call(everyField as never, asked as never)) as { data: { outcomes: Array<{ status: string }>; stored: number; refused: number } }
  check('an item whose optional fields are empty strings is stored (an empty replaces replaces nothing)', filled.data.stored === 1 && filled.data.refused === 0 && filled.data.outcomes[0]?.status === 'stored', JSON.stringify(filled.data), 'RetainTool in src/tools/memory/MemoryTools.ts and retainItems in src/sessions/mneme/memoryVerbs.ts must treat empty-string context, topic and replaces as absent')
  const filledRow = pendingRows(libDir).find(r => r.text.startsWith('a fact from a model that fills every optional field'))
  check('the row carries no pin, no asked mark, no replacement and no topic hint from the empty fields', filledRow !== undefined && filledRow.pin === undefined && filledRow.asked === undefined && filledRow.replaces === undefined && filledRow.topicHint === undefined && filledRow.text === 'a fact from a model that fills every optional field', JSON.stringify(filledRow), 'retainItems in src/sessions/mneme/memoryVerbs.ts must leave pin, asked, replaces and topicHint off the pending row when the optional fields are empty')
  const blankReplaces = retainItems([{ content: 'a fact with a blank replaces field', replaces: '   ' }], { session: 'proof' })
  check('a blank replaces is absent too', blankReplaces[0]?.status === 'stored', JSON.stringify(blankReplaces), 'retainItems in src/sessions/mneme/memoryVerbs.ts must trim replaces and treat a blank one as none')
  const namedReplaces = retainItems([{ content: 'a rule that names a replacement that is not a pinned rule', replaces: 'seq:999' }], { session: 'proof' })
  check('a replaces that names a seq is still checked and refused when that seq is not live', namedReplaces[0]?.status === 'refused' && /seq 999 is not live/.test((namedReplaces[0] as { reason?: string }).reason ?? ''), JSON.stringify(namedReplaces), 'replacementTarget in src/sessions/mneme/memoryVerbs.ts must refuse a replaces seq that is not live with the reason seq N is not live')
  check('force consolidation', maybeConsolidate({ force: true, dir: libDir }).consolidated, '', 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must consolidate the pending rows when forced')
  const recalled = recallQuery('round-trip', {})
  check('Recall finds the consolidated fact by id', recalled.hits.some(h => h.id.startsWith('seq:') && h.slug === 'tool-surface'), JSON.stringify(recalled.hits), 'recallQuery in src/sessions/mneme/memoryVerbs.ts must return consolidated facts with id seq:N and the slug of their topic')
  const byWords = recallQuery('how do the verbs reach the tool roster', {})
  check('Recall finds the fact from the words of a question that is no substring of it', byWords.hits.length === 1 && byWords.hits[0]!.id === recalled.hits[0]!.id && /^seq=\d+, time=.*, source=/.test(byWords.hits[0]!.signature), JSON.stringify(byWords.hits), 'recallQuery in src/sessions/mneme/memoryVerbs.ts must match a question by its words, and each hit signature must read seq=N, time=..., source=...')
  retainItems([{ content: 'a pending fact about the lantern smoke log under build/smoke', topic: 'tool surface' }], { session: 'proof' })
  const pendingByWords = recallQuery('where is the smoke log kept', {})
  check('the words also reach a pending row, labelled as such', pendingByWords.hits.length === 1 && pendingByWords.hits[0]!.label === 'pending' && pendingByWords.hits[0]!.id.startsWith('pending:') && pendingByWords.hits[0]!.signature.startsWith('time='), JSON.stringify(pendingByWords.hits), 'recallQuery in src/sessions/mneme/memoryVerbs.ts must also match pending rows by words, with label pending, an id starting pending: and a signature starting time=')
  const nothing = recallQuery('zebrafrost quintuple', {})
  check('words that match no fact recall nothing and the result is elidable', nothing.hits.length === 0 && nothing.elidable, '', 'recallQuery in src/sessions/mneme/memoryVerbs.ts must return no hits and elidable true when no fact matches')
  check('the tools answer isEnabled', RetainTool.isEnabled() && RecallTool.isEnabled(), '', 'isEnabled of RetainTool and RecallTool in src/tools/memory/MemoryTools.ts must answer true with no memory switch set')
}

section('§3 the memory switch takes the tools out, live')
{
  const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
  process.env.MERCURY_BARE = '1'
  check('with memory off the four tools leave the roster', !getAllBaseTools().some(t => TOOLS.includes(t.name)), '', 'getAllBaseTools in src/tools/kit/toolList.ts must drop the four memory tools when MERCURY_BARE is set (see memoryVerbsEnabled in src/sessions/mneme/memoryVerbs.ts)')
  delete process.env.MERCURY_BARE
  check('and come back when it is on', TOOLS.every(t => getAllBaseTools().some(x => x.name === t)), '', 'getAllBaseTools in src/tools/kit/toolList.ts must restore the four memory tools once MERCURY_BARE is unset, so read the switch live on each call')
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} MEMORY VERBS PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL MEMORY VERBS PROOFS PASS')
