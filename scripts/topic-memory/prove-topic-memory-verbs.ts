#!/usr/bin/env bun
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const memoryDir = mkdtempSync(join(tmpdir(), 'mneme-verbs-mem-'))
process.env.MERCURY_CONFIG_DIR = memoryDir
process.env.MERCURY_COORDINATION_MCP = '1'

const { createMercuryServer } = await import('../../src/services/mcp/mercuryServer.ts')
const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
  check('no memory verb in the catalog', names.every(n => !n.startsWith('mneme')), names.filter(n => n.startsWith('mneme')).join(','))
  check('the lease verbs and render_tui still present', names.includes('lease_take') && names.includes('lease_list') && names.includes('render_tui'))
  await close()
}

section('§2 the four tools, with nothing set, round-trip through the isolated home')
{
  const { getAllBaseTools } = await import('../../src/tools.ts')
  const names = getAllBaseTools().map(t => t.name)
  check('all four tools in the base roster', TOOLS.every(t => names.includes(t)), names.filter(n => TOOLS.includes(n)).join(','))
  const { RetainTool, RecallTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
  const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
  const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
  const { retainItems, recallQuery } = await import('../../src/mneme/memoryVerbs.ts')
  const stored = retainItems([{ content: 'the verbs round-trip through the real tool roster', topic: 'tool surface' }], { session: 'proof' })
  check('Retain stores', stored[0]?.status === 'stored', JSON.stringify(stored))
  const libDir = mnemeLibraryDir()
  check('the row landed in the ISOLATED home', libDir.startsWith(memoryDir) && existsSync(join(libDir, 'current.jsonl')), libDir)
  const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
  const everyField = RetainTool.inputSchema.parse({ items: [{ content: 'a fact from a model that fills every optional field', context: '', topic: '', pin: false, replaces: '' }] })
  const filled = (await RetainTool.call(everyField as never, {} as never)) as { data: { outcomes: Array<{ status: string }>; stored: number; refused: number } }
  check('an item whose optional fields are empty strings is stored (an empty replaces replaces nothing)', filled.data.stored === 1 && filled.data.refused === 0 && filled.data.outcomes[0]?.status === 'stored', JSON.stringify(filled.data))
  const filledRow = pendingRows(libDir).find(r => r.text.startsWith('a fact from a model that fills every optional field'))
  check('the row carries no pin, no asked mark, no replacement and no topic hint from the empty fields', filledRow !== undefined && filledRow.pin === undefined && filledRow.asked === undefined && filledRow.replaces === undefined && filledRow.topicHint === undefined && filledRow.text === 'a fact from a model that fills every optional field', JSON.stringify(filledRow))
  const blankReplaces = retainItems([{ content: 'a fact with a blank replaces field', replaces: '   ' }], { session: 'proof' })
  check('a blank replaces is absent too', blankReplaces[0]?.status === 'stored', JSON.stringify(blankReplaces))
  const namedReplaces = retainItems([{ content: 'a rule that names a replacement that is not a pinned rule', replaces: 'seq:999' }], { session: 'proof' })
  check('a replaces that names a seq is still checked and refused when it is no pinned rule', namedReplaces[0]?.status === 'refused' && /seq 999 is not a pinned rule/.test((namedReplaces[0] as { reason?: string }).reason ?? ''), JSON.stringify(namedReplaces))
  check('force consolidation', maybeConsolidate({ force: true, dir: libDir }).consolidated)
  const recalled = recallQuery('round-trip', {})
  check('Recall finds the consolidated fact by id', recalled.hits.some(h => h.id.startsWith('seq:') && h.slug === 'tool-surface'), JSON.stringify(recalled.hits))
  const byWords = recallQuery('how do the verbs reach the tool roster', {})
  check('Recall finds the fact from the words of a question that is no substring of it', byWords.hits.length === 1 && byWords.hits[0]!.id === recalled.hits[0]!.id && /^seq=\d+, time=.*, source=/.test(byWords.hits[0]!.signature), JSON.stringify(byWords.hits))
  retainItems([{ content: 'a pending fact about the lantern smoke log under build/smoke', topic: 'tool surface' }], { session: 'proof' })
  const pendingByWords = recallQuery('where is the smoke log kept', {})
  check('the words also reach a pending row, labelled as such', pendingByWords.hits.length === 1 && pendingByWords.hits[0]!.label === 'pending' && pendingByWords.hits[0]!.id.startsWith('pending:') && pendingByWords.hits[0]!.signature.startsWith('time='), JSON.stringify(pendingByWords.hits))
  const nothing = recallQuery('zebrafrost quintuple', {})
  check('words that match no fact recall nothing and the result is elidable', nothing.hits.length === 0 && nothing.elidable)
  check('the tools answer isEnabled', RetainTool.isEnabled() && RecallTool.isEnabled())
}

section('§3 the memory switch takes the tools out, live')
{
  const { getAllBaseTools } = await import('../../src/tools.ts')
  process.env.MERCURY_BARE = '1'
  check('with memory off the four tools leave the roster', !getAllBaseTools().some(t => TOOLS.includes(t.name)))
  delete process.env.MERCURY_BARE
  check('and come back when it is on', TOOLS.every(t => getAllBaseTools().some(x => x.name === t)))
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} MEMORY VERBS PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL MEMORY VERBS PROOFS PASS')
