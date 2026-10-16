;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import type { CompactMetadata, Message } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'fold-receipts-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY ??= 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compactConversation, partialCompactConversation } = await import('../../src/services/compact/compact.ts')
const prompts = (await import('../../src/services/compact/prompt.ts')) as { renderFoldedWork?: (work: CompactMetadata['work'] | undefined) => string | null }
const renderFoldedWork = prompts.renderFoldedWork ?? (() => null)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')

let failures = 0
let checks = 0
const check = (label: string, condition: boolean, detail = '') => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition || !detail ? '' : `: ${detail}`}`)
}
let clock = Date.UTC(2026, 9, 15)
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date(clock++).toISOString(), message: { id: randomUUID(), role: 'assistant', content } }) as Message
function round(name: string, input: Record<string, unknown> = {}, lines?: string[], error = false): Message[] {
  const id = randomUUID()
  const call = assistant([{ type: 'tool_use', id, name, input }])
  const result = user([{ type: 'tool_result', tool_use_id: id, content: 'done', ...(error ? { is_error: true } : {}) }])
  if (lines) Object.assign(result, { toolUseResult: { filePath: input.file_path, structuredPatch: [{ lines }] } })
  return [call, result]
}
const history: Message[] = [user('Repair the inventory reader and prove it.')]
for (const [name, input, lines, error] of [
  ['Read', { file_path: '/repo/inventory.py' }],
  ['Edit', { file_path: '/repo/denied.py' }, undefined, true],
  ['Read', { file_path: '/repo/stock.csv' }],
  ['Bash', { command: 'python inventory.py stock.csv' }],
  ['Grep', { pattern: 'qty' }],
  ['Edit', { file_path: '/repo/inventory.py' }, ['+a1', '+a2', '+a3', '+a4', '-d1']],
  ['Bash', { command: 'python inventory.py stock.csv' }],
  ['Write', { file_path: '/repo/test_inventory.py' }, ['+t1', '+t2', '+t3', '+t4', '+t5', '+t6']],
  ['Bash', { command: 'python -m unittest' }],
  ['Bash', { command: 'python -m unittest' }],
  ['Read', { file_path: '/repo/test_inventory.py' }],
] as Array<[string, Record<string, unknown>, string[]?, boolean?]>) history.push(...round(name, input, lines, error ?? false))
history.push(assistant([{ type: 'text', text: 'The reader is repaired and the checks pass.' }]))

const makeContext = () => {
  const appState = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], commands: [], resources: {} } }
  return { abortController: new AbortController(), getAppState: () => appState, setAppState: () => {}, messages: [], readFileState: new Map(), options: { tools: [], mcpClients: [], engineModel: getEngineModel(), thinkingConfig: { type: 'adaptive' as const }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } } as never
}
const SUMMARY_WORDS = 'The inventory reader was repaired and its tests passed. Preserve the completed work and continue with the next operator request.'
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: SUMMARY_WORDS })))
process.env.ANTHROPIC_BASE_URL = api.url
const summaryTextOf = (result: { summaryMessages: Message[] }): string => {
  const content = result.summaryMessages[0]?.message.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(block => (block as { text?: string }).text ?? '').join('\n') : ''
}

try {
  console.log('\n1. the renderer over the receipts a boundary already carries')
  check('no work renders nothing', renderFoldedWork(undefined) === null)
  check('empty work renders nothing', renderFoldedWork({ receipts: [], recap: { turns: 0, toolCounts: [], files: [], toolFailures: 0, failedToolUseIds: [] } }) === null)
  const work: NonNullable<CompactMetadata['work']> = {
    receipts: [
      {
        beforeUuid: 'b',
        anchorUuid: 'a',
        counts: { scratchpadEdits: 0, fileEdits: 3, adds: 14, dels: 2, reads: 1, searches: 2, fetches: 0, commands: 7, browser: 0, agents: 1, delegatedTokens: 0, delegatedCostUSD: 0, delegatedUnpriced: 0 },
      },
    ],
    recap: {
      turns: 2,
      toolCounts: [['Read', 3], ['Bash', 7], ['Edit', 2], ['Grep', 1]],
      files: Array.from({ length: 26 }, (_, index) => `/repo/file-${index}.py`),
      toolFailures: 1,
      failedToolUseIds: ['x'],
    },
  }
  const text = renderFoldedWork(work) ?? ''
  const lines = text.split('\n')
  check('the block opens with its deterministic heading', lines[0] === "## Folded work (deterministic — from the fold's receipts, not summarized)", lines[0] ?? '')
  check('turns, tool counts (most used first) and failures ride one line', lines[1] === 'Operator turns folded: 2 · tool calls: Bash×7, Read×3, Edit×2, Grep×1 · failed tool calls: 1', lines[1] ?? '')
  check('a straddling turn\'s folded counts read in the receipt row\'s words', lines[2] === 'Folded part of a turn that continues below: 3 file edits +14 −2 · 1 read · 2 searches · 7 shell commands · 1 crewmate', lines[2] ?? '')
  check('the file list is bounded at 24 with the remainder counted', /^Files the folded tools touched \(re-READ on demand — contents not carried\): \/repo\/file-0\.py, .*\/repo\/file-23\.py …\+2 more$/.test(lines[3] ?? ''), lines[3] ?? '')
  check('nothing else rides the block', lines.length === 4, String(lines.length))

  console.log('\n2. the full fold carries the receipts inside the summary message')
  const folded = await compactConversation(history, makeContext(), { systemPrompt: ['fixture posture'] } as never, true)
  const summary = summaryTextOf(folded)
  check('the model\'s words are there', summary.includes(SUMMARY_WORDS))
  check('the folded-work block follows them', summary.indexOf('## Folded work') > summary.indexOf(SUMMARY_WORDS), summary.slice(0, 200))
  const kept = folded.messagesToKeep ?? []
  check('the verbatim tail keeps the last rounds, so the fold covers only the earlier ones', kept.length > 0 && kept.length < history.length, String(kept.length))
  const boundaryWork = folded.boundaryMarker.compactMetadata.work
  const toolLine = summary.split('\n').find(l => l.startsWith('Operator turns folded')) ?? ''
  const fileLine = summary.split('\n').find(l => l.startsWith('Files the folded tools touched')) ?? ''
  const expectedTools = [...(boundaryWork?.recap.toolCounts ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${name}×${n}`).join(', ')
  check('the tool calls are counted by name, the folded rounds only', toolLine === `Operator turns folded: 1 · tool calls: ${expectedTools} · failed tool calls: 1`, toolLine)
  check('the folded rounds include the first read and the denied edit', /Read×\d/.test(toolLine) && /Edit×\d/.test(toolLine), toolLine)
  check('the files the folded tools touched are the boundary\'s own list', fileLine === `Files the folded tools touched (re-READ on demand — contents not carried): ${(boundaryWork?.recap.files ?? []).join(', ')}`, fileLine)
  check('the first read file is listed', fileLine.includes('/repo/inventory.py'), fileLine)
  check('a denied edit\'s file is not listed as touched', !summary.includes('/repo/denied.py'))
  check('the summary message words that the scans know it by still open the text', summary.startsWith('The context window turned over'))
  check('the kept tail is untouched by the block', kept.every(m => !JSON.stringify(m).includes('Folded work')))

  console.log('\n3. the partial fold carries them too')
  for (const direction of ['up_to', 'from'] as const) {
    const cut = await partialCompactConversation(history, 6, makeContext(), { systemPrompt: ['fixture posture'] } as never, undefined, direction)
    const text = summaryTextOf(cut)
    check(`${direction}: the summary carries the folded-work block`, text.includes('## Folded work'), text.slice(0, 160))
    check(`${direction}: the block names a file the summarised part touched`, /\/repo\/(inventory\.py|test_inventory\.py)/.test(text))
  }
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} fold receipts in summary (${checks} checks, ${failures} failures)`)
process.exit(failures ? 1 : 0)
