#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sent-prefix-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.ANTHROPIC_BASE_URL

import { bindingDropsFor, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — sent-prefix proofs exceeded 280s')
  process.exit(1)
}, 280_000)
guard.unref?.()

type Block = Record<string, unknown>
const THINK = (text: string): Block => ({ type: 'thinking', thinking: text, signature: 'sig-' + text })
const TEXT = (text: string): Block => ({ type: 'text', text })
let seq = 0
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function user(content: Block[] | string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq++
  return { type: 'user', uuid: uuidOf(seq), timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content }, ...extra }
}
function assistant(content: Block[]): Record<string, unknown> {
  seq++
  return {
    type: 'assistant',
    uuid: uuidOf(seq),
    timestamp: '2026-09-01T00:00:00.000Z',
    requestId: `req_${seq}`,
    message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: 'claude-fable-5-1', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  }
}
function localCommand(stdout: string): Record<string, unknown> {
  seq++
  return { type: 'system', subtype: 'local_command', uuid: uuidOf(seq), timestamp: '2026-09-01T00:00:00.000Z', content: `<local-command-stdout>${stdout}</local-command-stdout>`, isMeta: false, level: 'info' }
}
function attachmentRow(attachment: Record<string, unknown>): Record<string, unknown> {
  seq++
  return { type: 'attachment', uuid: uuidOf(seq), timestamp: '2026-09-01T00:00:00.000Z', attachment }
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = k === 'input' || k === 'input_schema' ? v : withoutCacheControl(v)
    }
    return out
  }
  return value
}
function wireOf(m: unknown): string {
  const row = m as { message?: { role?: string; content?: unknown } }
  return j(withoutCacheControl({ role: row.message?.role, content: row.message?.content }))
}

section('§1 the projection law — appended rows extend the view, never rewrite it')
{
  const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
  const { enforceToolResultBudget, createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
  const isPrefix = (earlier: unknown[], later: unknown[]): { ok: boolean; at: number } => {
    for (let k = 0; k < earlier.length; k++) {
      if (wireOf(earlier[k]) !== wireOf(later[k])) return { ok: false, at: k }
    }
    return { ok: true, at: -1 }
  }
  const REMINDER = '<system-reminder>\n# claudeMd\nbe brief\n</system-reminder>'
  const ctxRow = (): Record<string, unknown> => attachmentRow({ type: 'user_context', body: REMINDER })

  const h1 = [ctxRow(), user('first prompt')]
  const p1 = normalizeMessagesForAPI(h1 as never)
  check('turn 1 projects to one user turn carrying the context row and the prompt', p1.length === 1 && wireOf(p1[0]).includes('be brief') && wireOf(p1[0]).includes('first prompt'), wireOf(p1[0]).slice(0, 200))

  const h2 = [...h1, assistant([THINK('one'), TEXT('a')]), localCommand('ls output'), attachmentRow({ type: 'edited_text_file', filename: '/x/note.txt', snippet: '1: new bytes' }), user('second prompt')]
  const p2 = normalizeMessagesForAPI(h2 as never)
  const pre2 = isPrefix(p1, p2)
  check('turn 2: the turn-1 view is a byte-identical prefix (the `!` row and the attachment ride the NEW user turn)', pre2.ok && p2.length === 3, `at=${pre2.at} rows=${p2.length}`)
  check('…the `!` output and the file notice sit in the last user turn, after the reply', wireOf(p2[2]).includes('ls output') && wireOf(p2[2]).includes('new bytes') && wireOf(p2[2]).includes('second prompt'), wireOf(p2[2]).slice(0, 300))

  const h3 = [...h2, assistant([THINK('two'), { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x/note.txt' } }]), user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'bytes' }]), assistant([THINK('three'), TEXT('b')]), attachmentRow({ type: 'user_context', body: REMINDER + '\n<!-- newer -->' }), user('third prompt')]
  const p3 = normalizeMessagesForAPI(h3 as never)
  const pre3 = isPrefix(p2, p3)
  check('turn 3: the turn-2 view is a byte-identical prefix across a tool round', pre3.ok && p3.length === 7, `at=${pre3.at} rows=${p3.length}`)
  check('…a fresh user-context copy rides the tail turn; messages[0] keeps the first copy', wireOf(p3[0]) === wireOf(p1[0]) && wireOf(p3[6]).includes('newer'), wireOf(p3[6]).slice(0, 200))

  const b1 = [localCommand('early ls'), ctxRow(), user('first prompt')]
  const q1 = normalizeMessagesForAPI(b1 as never)
  const q2 = normalizeMessagesForAPI([...b1, assistant([THINK('one'), TEXT('a')]), user('second prompt')] as never)
  check('a `!` line before the first prompt is part of messages[0] on every later request', q1.length === 1 && isPrefix(q1, q2).ok && wireOf(q2[0]).includes('early ls'), wireOf(q2[0]).slice(0, 200))

  const big = 'x'.repeat(400_000)
  const state = createContentReplacementState()
  const round = [user('read it'), assistant([{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'cat big' } }]), user([{ type: 'tool_result', tool_use_id: 'toolu_big', content: big }])]
  const first = await enforceToolResultBudget(round as never, state)
  check('an oversized result is decided on first sight (replaced in the turn it arrives)', first.replacements.length === 1 && !wireOf(first.messages[2]).includes(big), `replacements=${first.replacements.length}`)
  const later = await enforceToolResultBudget([...first.messages, assistant([THINK('x'), TEXT('ok')]), user('next')] as never, state)
  check('the budget never rewrites a result it already decided (the sent turn is byte-identical, nothing new recorded)', wireOf(later.messages[2]) === wireOf(first.messages[2]) && later.replacements.length === 0, `replacements=${later.replacements.length}`)
}

section('§1b the tool roster freeze (pure) — a latched decision holds; a joiner rides deferred or is held')
{
  const { planToolPayload, clearToolRosterLatches, toolRosterLatchFor } = await import('../../src/services/providers/toolEconomy.ts')
  const { TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { z } = await import('zod/v4')
  const fakeTool = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name,
    isMcp: false,
    inputSchema: z.object({}).passthrough(),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    description: async () => `${name} tool`,
    prompt: async () => `${name} prompt`,
    shouldDefer: false,
    ...over,
  })
  const search = fakeTool(TOOL_SEARCH_TOOL_NAME)
  const readTool = fakeTool('Read')
  const names = (plan: { roster: Array<{ name: string }> }): string => j(plan.roster.map(t => t.name))
  const plan = (tools: Record<string, unknown>[], over: { pending?: boolean; key?: string; mode?: string } = {}) =>
    planToolPayload({
      model: 'claude-opus-4-8',
      tools: tools as never,
      messages: [],
      getToolPermissionContext: async () => ({ ...getEmptyToolPermissionContext(), mode: (over.mode ?? 'default') as never }),
      agents: [],
      hasPendingMcpServers: over.pending,
      source: 'prove',
      ...(over.key !== undefined ? { latchKey: over.key } : {}),
    })
  const saved = process.env.MERCURY_TOOL_SEARCH
  delete process.env.MERCURY_TOOL_SEARCH
  clearToolRosterLatches()

  const free1 = await plan([search, readTool], { pending: true })
  const free2 = await plan([search, readTool], { pending: false })
  check('control (no latch): pending servers ⇒ search on; landed with nothing deferred ⇒ off — the roster moves', free1.enabled && !free2.enabled && names(free1) !== names(free2), `${names(free1)} → ${names(free2)}`)

  const deferrable = fakeTool('Browser', { shouldDefer: true })
  const p1 = await plan([search, readTool, deferrable], { pending: true, key: 'conv-a' })
  const p2 = await plan([search, readTool, deferrable], { pending: false, key: 'conv-a' })
  check('latched: the first request decided search on; the servers landing leaves the roster byte-identical', p1.enabled && p2.enabled && names(p1) === names(p2), `${names(p1)} → ${names(p2)}`)
  check('THE ROSTER LAW: a deferrable tool rides the roster from the FIRST request (deferred on the wire), never held back for an admission', names(p1) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'Browser']) && p1.deferredNames.has('Browser') && !p1.admittedNames.has('Browser'), names(p1))
  check('…the latch records the decision and the names it saw, in order', toolRosterLatchFor('conv-a', [], 'claude-opus-4-8')?.enabled === true && j(toolRosterLatchFor('conv-a', [], 'claude-opus-4-8')?.names) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'Browser']))
  const admitted = [user('one'), assistant([{ type: 'tool_use', id: 'toolu_ts', name: TOOL_SEARCH_TOOL_NAME, input: { query: 'browser' } }]), user([{ type: 'tool_result', tool_use_id: 'toolu_ts', content: [{ type: 'tool_reference', tool_name: 'Browser' }] }])]
  const pAdmit = await planToolPayload({ model: 'claude-opus-4-8', tools: [search, readTool, deferrable] as never, messages: admitted as never, getToolPermissionContext: async () => ({ ...getEmptyToolPermissionContext(), mode: 'default' as never }), agents: [], hasPendingMcpServers: false, source: 'prove', latchKey: 'conv-adm' })
  const pAdmit2 = await planToolPayload({ model: 'claude-opus-4-8', tools: [search, readTool, deferrable] as never, messages: admitted as never, getToolPermissionContext: async () => ({ ...getEmptyToolPermissionContext(), mode: 'default' as never }), agents: [], hasPendingMcpServers: false, source: 'prove', latchKey: 'conv-adm' })
  check('an admission adds nothing to the roster (the admitted tool was there, deferred, from the first request) and it is admitted', names(pAdmit) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'Browser']) && pAdmit.admittedNames.has('Browser') && !pAdmit.isDeferredUnadmitted('Browser') && names(pAdmit2) === names(pAdmit), names(pAdmit))
  const mcpTool = fakeTool('mcp__srv__late', { isMcp: true, mcpInfo: { serverName: 'srv' } })
  const p3 = await plan([search, readTool, deferrable, mcpTool], { pending: false, key: 'conv-a' })
  check('a deferrable tool that joins later under a deferring latch is appended at the END, deferred (an unreferenced deferred tool is not part of the prefix); the earlier order holds', names(p3) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'Browser', 'mcp__srv__late']) && p3.deferredNames.has('mcp__srv__late'), names(p3))
  const reordered = await plan([mcpTool, deferrable, readTool, search], { pending: false, key: 'conv-a' })
  check('…and a pool that arrives in another order still sends the latched order (never a reorder)', names(reordered) === names(p3), names(reordered))
  const lateFull = fakeTool('LateBuiltin')
  const p3b = await plan([search, readTool, deferrable, mcpTool, lateFull], { pending: false, key: 'conv-a' })
  check('a NON-deferrable joiner is held even under a deferring latch (a regular tool added later is an edit)', names(p3b) === names(p3), names(p3b))
  const other = [user('another chat')]
  const o1 = await planToolPayload({ model: 'claude-opus-4-8', tools: [search, readTool, mcpTool] as never, messages: other as never, getToolPermissionContext: async () => ({ ...getEmptyToolPermissionContext(), mode: 'default' as never }), agents: [], hasPendingMcpServers: false, source: 'prove', latchKey: 'conv-a' })
  check('a different first row under the same owner keys its own latch (a new chat, or the post-compaction summary)', toolRosterLatchFor('conv-a', other as never, 'claude-opus-4-8') !== undefined && toolRosterLatchFor('conv-a', other as never, 'claude-opus-4-8') !== toolRosterLatchFor('conv-a', [], 'claude-opus-4-8') && o1.deferredNames.has('mcp__srv__late'), names(o1))
  const p4 = await plan([search, readTool, mcpTool], { pending: false, key: 'conv-b' })
  check('another conversation decides for itself (its first request sees the joiner)', p4.deferredNames.has('mcp__srv__late') && names(p4) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'mcp__srv__late']), names(p4))

  const swarm = fakeTool('TeamCreate', { shouldDefer: true })
  const m1 = await plan([search, readTool, swarm], { pending: false, key: 'conv-marks' })
  const m2 = await plan([search, readTool], { pending: false, key: 'conv-marks' })
  check('THE MARKS ARE FROZEN: a deferrable tool the pool drops (a toggle) still rides the array AND keeps its deferral mark', m1.enabled && names(m2) === names(m1) && m1.deferredNames.has('TeamCreate') && m2.deferredNames.has('TeamCreate'), `${names(m2)} deferred=${j([...m2.deferredNames])}`)
  const lsp = fakeTool('LspTool')
  const lspPlan = (rule: (t: { name: string }) => boolean) =>
    planToolPayload({ model: 'claude-opus-4-8', tools: [search, readTool, swarm, lsp] as never, messages: [], getToolPermissionContext: async () => ({ ...getEmptyToolPermissionContext(), mode: 'default' as never }), agents: [], hasPendingMcpServers: false, source: 'prove', latchKey: 'conv-lsp', alsoDefer: rule as never })
  const l1 = await lspPlan(t => t.name === 'LspTool')
  const l2 = await lspPlan(() => false)
  check("a lane's own deferral rule is judged once: the tool it deferred at the first request stays deferred when the rule later says no", l1.deferredNames.has('LspTool') && l2.deferredNames.has('LspTool') && names(l2) === names(l1), j([...l2.deferredNames]))
  const j1 = await plan([search, readTool, swarm, mcpTool], { pending: false, key: 'conv-marks' })
  const j2 = await plan([search, readTool], { pending: false, key: 'conv-marks' })
  check('a joiner appended once keeps its position and its mark for good — even after it leaves the pool again', names(j1) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'TeamCreate', 'mcp__srv__late']) && names(j2) === names(j1) && j2.deferredNames.has('mcp__srv__late'), `${names(j2)} deferred=${j([...j2.deferredNames])}`)
  const sumPlan = await plan([readTool, search], { pending: false, key: 'conv-marks' })
  check("the summariser's plan under the conversation's key — from its own two-tool pool — yields the conversation's array and marks, byte for byte", names(sumPlan) === names(j1) && j([...sumPlan.deferredNames].sort()) === j([...j1.deferredNames].sort()), names(sumPlan))
  const forkSrc = readFileSync(join(ROOT, 'src', 'utils', 'forkedAgent.ts'), 'utf8')
  const tmSrc = readFileSync(join(ROOT, 'src', 'run-core', 'turn-machine.ts'), 'utf8')
  const compactSrc = readFileSync(join(ROOT, 'src', 'services', 'compact', 'compact.ts'), 'utf8')
  const scSrc = readFileSync(join(ROOT, 'src', 'services', 'providers', 'anthropic', 'streamCore.ts'), 'utf8')
  check("the fork runner stamps the parent's roster owner on the fork context (rosterOwner)", forkSrc.includes('rosterOwner: rosterOwnerFromToolUseContext(cacheSafeParams.toolUseContext)'))
  check('the turn machine keys the roster latch on the roster owner', tmSrc.includes('ownerKey: String(rosterOwnerFromToolUseContext(toolUseContext))'))
  check("the direct summariser road keys the latch on the conversation's roster owner", compactSrc.includes('ownerKey: String(rosterOwnerFromToolUseContext(context))'))
  check('the Anthropic lane never re-reads a deferral mark live (the LSP rule rides the plan, judged once)', scSrc.includes('alsoDefer: shouldDeferLspTool') && !/willDefer = [^\n]*shouldDeferLspTool/.test(scSrc))

  process.env.MERCURY_TOOL_SEARCH = '0'
  const s1 = await plan([search, readTool, deferrable], { key: 'conv-c' })
  const late = fakeTool('LateBuiltin')
  const s2 = await plan([search, readTool, deferrable, late], { key: 'conv-c' })
  check('search off by policy: the roster carries every tool in full (no ToolSearch), the deferrable one included', !s1.enabled && names(s1) === j(['Read', 'Browser']) && s1.deferredNames.size === 0, names(s1))
  check('…a tool that joins later is held: the roster stays byte-identical', names(s2) === names(s1), names(s2))
  const s3 = await plan([search, readTool, deferrable, late], { key: 'conv-c', mode: 'apollo' })
  check('A MODE CHANGE NEVER REWRITES THE PREFIX: the same latch serves every mode, the roster byte-identical', names(s3) === names(s1), names(s3))
  clearToolRosterLatches()
  const s4 = await plan([search, readTool, deferrable, late], { key: 'conv-c' })
  check('clearing every latch (the process-wide reset) re-decides: the joiner enters', names(s4) === j(['Read', 'Browser', 'LateBuiltin']), names(s4))
  const s5 = await plan([search, readTool, late], {})
  check('no latch key ⇒ no latch (a one-off caller decides fresh)', names(s5) === j(['Read', 'LateBuiltin']) && toolRosterLatchFor('undefined', [], 'claude-opus-4-8') === undefined, names(s5))

  const { declareLawfulPrefixChange, pendingLawfulPrefixChange, resetLawfulPrefixChanges } = await import('../../src/services/providers/lawfulPrefixChange.ts')
  await plan([search, readTool], { key: 'conv-d' })
  declareLawfulPrefixChange('conv-d', 'the operator toggled sub-agents off')
  check('declareLawfulPrefixChange records its reason and leaves the roster latch in place (the change rides a new row, not the wire)', toolRosterLatchFor('conv-d', [], 'claude-opus-4-8') !== undefined && pendingLawfulPrefixChange('conv-d') === 'the operator toggled sub-agents off')
  const d2 = await plan([search, readTool, late], { key: 'conv-d' })
  check('…so the declaring conversation keeps its frozen roster too', names(d2) === j(['Read']), names(d2))
  resetLawfulPrefixChanges()
  if (saved === undefined) delete process.env.MERCURY_TOOL_SEARCH
  else process.env.MERCURY_TOOL_SEARCH = saved
  clearToolRosterLatches()
}

section('§1c the resume restore (pure) — the first exchange record, then a NEW process re-sends the frozen roster and sections byte for byte')
{
  const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore, pendingToolRosterRestore, conversationRosterKey } =
    await import('../../src/services/providers/toolEconomy.ts')
  const { buildBoundPrefixRecordData, boundPrefixRecordToEmit, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted, boundPrefixRecordExists } =
    await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
  const { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry, clearSystemPromptSectionState } = await import('../../src/bootstrap/state.ts')
  const { getSystemContext } = await import('../../src/context.ts')
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
  const { isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
  const { z } = await import('zod/v4')
  const savedSearch = process.env.MERCURY_TOOL_SEARCH
  process.env.MERCURY_TOOL_SEARCH = 'tst'
  const MODEL = 'claude-opus-4-8'
  const fakeTool = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name, isMcp: false, inputSchema: z.object({}).passthrough(), isConcurrencySafe: () => true, isReadOnly: () => true,
    description: async () => `${name} tool`, prompt: async () => `${name} prompt`, shouldDefer: false, ...over,
  })
  const search = fakeTool(TOOL_SEARCH_TOOL_NAME)
  const read = fakeTool('Read')
  const browser = fakeTool('Browser', { shouldDefer: true })
  const godot = fakeTool('Godot', { shouldDefer: true })
  const owner = 'conv-resume'
  const messages = [{ type: 'user', uuid: 'u-first-exchange', message: { role: 'user', content: 'first' } }]
  const rosterNames = (plan: { roster: Array<{ name: string }> }): string => j(plan.roster.map(t => t.name))
  const marks = (plan: { deferredNames: ReadonlySet<string> }): string => j([...plan.deferredNames].sort())
  const doPlan = (tools: Record<string, unknown>[], key: string = owner, msgs = messages) =>
    planToolPayload({ model: MODEL, tools: tools as never, messages: msgs as never, getToolPermissionContext: async () => ({ ...getEmptyToolPermissionContext(), mode: 'default' as never }), agents: [], hasPendingMcpServers: false, source: 'prove', latchKey: key })
  const contextCache = getSystemContext.cache as { set: (k: unknown, v: unknown) => unknown; clear?: () => void; has: (k: unknown) => boolean }
  const freshProcess = (): void => { clearToolRosterLatches(); clearToolRosterRestore(); clearSystemPromptSectionState(); resetBoundPrefixEmitted(); contextCache.clear?.() }

  freshProcess()
  setSystemPromptSectionCacheEntry('mode-vulcan', null, null)
  setSystemPromptSectionCacheEntry('memory', 'the memory as first seen', null)
  contextCache.set(undefined, Promise.resolve({ gitStatus: 'the tree as first seen' }))
  const p1 = await doPlan([search, read, browser])
  const names1 = rosterNames(p1)
  const marks1 = marks(p1)
  const boundKey = conversationRosterKey(owner, messages as never, MODEL)

  const record = await buildBoundPrefixRecordData(owner, messages as never, MODEL)
  check('§1c the record captures the frozen roster (names in first-sent order + deferral marks)', record !== null && j(record.roster.map(t => t.name)) === j(p1.roster.map(t => t.name)) && record.roster.some(t => t.name === 'Browser' && t.deferred), record ? j(record.roster) : 'null')
  check('§1c the record captures the cached sections (name, key, text — an absent section as null)', record !== null && record.sections.some(s => s.name === 'mode-vulcan' && s.value === null) && record.sections.some(s => s.name === 'memory' && s.value === 'the memory as first seen'), record ? j(record.sections) : 'null')
  check('§1c the record captures the system context the request appended (the git-status snapshot)', record?.systemContext.gitStatus === 'the tree as first seen', j(record?.systemContext))
  check('§1c the record key is the conversation key (owner | first row | model)', record?.boundKey === boundKey, `${record?.boundKey} vs ${boundKey}`)

  const emitted = await boundPrefixRecordToEmit(owner, messages as never, MODEL)
  check('§1c the record emits as an attachment (bound_prefix), null-rendering AND projecting NOTHING to the wire', emitted !== null && emitted.type === 'attachment' && emitted.attachment.type === 'bound_prefix' && normalizeAttachmentForAPI(emitted.attachment).length === 0 && isNullRenderingAttachment(emitted), emitted ? `render=${isNullRenderingAttachment(emitted)} wire=${normalizeAttachmentForAPI(emitted.attachment).length}` : 'null')
  check('§1c a second emit is null (one record per conversation)', (await boundPrefixRecordToEmit(owner, messages as never, MODEL)) === null)
  check('§1c the record is found in a history that carries it', emitted !== null && boundPrefixRecordExists([emitted as never], boundKey))
  const recordMessage = emitted!

  freshProcess()
  check('§1c a new process has no latch, no cached sections and no composed context (the freeze does not survive a process)', getSystemPromptSectionCache().size === 0 && pendingToolRosterRestore() === null && !contextCache.has(undefined))
  const restoredKey = restoreBoundPrefixFromMessages([recordMessage as never])
  check('§1c the resume loader restored the record: the sections seeded into the cache, the roster armed', restoredKey === boundKey && getSystemPromptSectionCache().get('mode-vulcan')?.value === null && getSystemPromptSectionCache().get('memory')?.value === 'the memory as first seen' && pendingToolRosterRestore()?.key === boundKey, `${restoredKey}; sections=${getSystemPromptSectionCache().size}`)
  check('§1c …and the system-context memo serves the recorded snapshot (a tree that moved since never rewrites the last system block)', contextCache.has(undefined) && (await getSystemContext()).gitStatus === 'the tree as first seen', j(await getSystemContext()))

  const p2 = await doPlan([search, read, browser])
  check('§1c the resumed plan re-sends the frozen roster byte for byte (names + deferral marks)', rosterNames(p2) === names1 && marks(p2) === marks1 && p2.restoredMissingTools.length === 0, `${rosterNames(p2)} vs ${names1}`)

  const p3 = await doPlan([search, read, browser, godot])
  check('§1c a tool that gated in after the record is a joiner (appended deferred, unreferenced) — the frozen prefix never gains it', p3.roster.slice(0, p1.roster.length).map(t => t.name).join(',') === p1.roster.map(t => t.name).join(',') && p3.deferredNames.has('Godot'), `${rosterNames(p3)}`)

  freshProcess()
  restoreBoundPrefixFromMessages([recordMessage as never])
  const p4 = await doPlan([search, browser])
  check('§1c R3 — a bound tool the record carried that this build no longer offers is reported (the caller declares the lawful change)', p4.restoredMissingTools.includes('Read'), j(p4.restoredMissingTools))

  freshProcess()
  restoreBoundPrefixFromMessages([recordMessage as never])
  const forkOwner = 'conv-resume-FORKED'
  const pFork = await doPlan([search, read, browser], forkOwner)
  check('§1c a fork (a fresh owner, the same first exchange) restores the frozen roster too', rosterNames(pFork) === names1 && marks(pFork) === marks1, `${rosterNames(pFork)} vs ${names1}`)

  const savedKeepTail = process.env.MERCURY_COMPACT_KEEP_TAIL
  process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  freshProcess()
  const restoredKT = restoreBoundPrefixFromMessages([recordMessage as never])
  const pKT = await doPlan([search, read, browser])
  check('§1c a resume with keep-tail on restores the frozen prefix byte for byte (0 drops — the tail arm never touches the first exchange)', restoredKT === boundKey && rosterNames(pKT) === names1 && marks(pKT) === marks1 && pKT.restoredMissingTools.length === 0 && getSystemPromptSectionCache().get('memory')?.value === 'the memory as first seen', `${rosterNames(pKT)} vs ${names1}`)
  if (savedKeepTail === undefined) delete process.env.MERCURY_COMPACT_KEEP_TAIL
  else process.env.MERCURY_COMPACT_KEEP_TAIL = savedKeepTail

  freshProcess()
  if (savedSearch === undefined) delete process.env.MERCURY_TOOL_SEARCH
  else process.env.MERCURY_TOOL_SEARCH = savedSearch
}

section('serialized tool definitions remain fixed across refresh and reconstruction')
{
  const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/services/providers/toolEconomy.ts')
  const { toolToAPISchema } = await import('../../src/utils/api.ts')
  const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
  const { boundPrefixRecordToEmit, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
  const { gateToolCall } = await import('../../src/services/providers/toolCallGate.ts')
  const { z } = await import('zod/v4')
  const model = 'claude-fable-5-1'
  const key = 'schema-conversation'
  const messages = [user('Use the available tools.')]
  const tool = (name: string, field: string, description: string, deferred = false) => ({
    name,
    inputSchema: z.object({ [field]: z.string() }),
    inputJSONSchema: { type: 'object', properties: { [field]: { type: 'string' } }, required: [field] },
    prompt: async () => description,
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    shouldDefer: deferred,
  })
  const firstTool = tool('ReadFixture', 'before', 'First description')
  const changedTool = tool('ReadFixture', 'after', 'Changed description')
  const deferredTool = tool('DeferredFixture', 'query', 'Deferred description', true)
  const pool = [firstTool, ToolSearchTool, deferredTool]
  const plan = (tools: unknown[], conversation = key) => planToolPayload({
    model,
    tools: tools as never,
    messages: messages as never,
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    agents: [],
    latchKey: conversation,
  })
  const schemas = (value: Awaited<ReturnType<typeof planToolPayload>>) => Promise.all(value.roster.map(t => toolToAPISchema(t, {
    model,
    tools: value.roster,
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    agents: [],
    deferLoading: value.deferredNames.has(t.name),
    conversationKey: value.conversationKey,
  })))
  const freshProcess = () => { clearToolRosterLatches(); clearToolRosterRestore(); clearToolSchemaCache(); resetBoundPrefixEmitted() }
  const saved = process.env.MERCURY_TOOL_SEARCH
  process.env.MERCURY_TOOL_SEARCH = 'on'
  freshProcess()
  const first = await schemas(await plan(pool))
  const record = await boundPrefixRecordToEmit(key, messages as never, model)
  check('the persisted record contains each complete serialized definition', record?.attachment.type === 'bound_prefix' && record.attachment.roster.every(mark => typeof mark.definition === 'string'))
  const persisted = JSON.parse(j(record))
  clearToolSchemaCache()
  const livePool = [changedTool, ToolSearchTool, deferredTool]
  const second = await schemas(await plan(livePool))
  check('refetched same-name tools and credential memo clearing leave request definitions unchanged', j(first) === j(second))
  const accepted = gateToolCall(livePool as never, { id: 'new-input', name: changedTool.name, argumentsRaw: '{"after":"value"}', malformed: false })
  check('the execution registry still uses the current tool implementation', accepted.ok)
  check('unchanged definitions do not append another saved-prefix record', await boundPrefixRecordToEmit(key, messages as never, model) === null)
  freshProcess()
  restoreBoundPrefixFromMessages([persisted])
  const restoredPlan = await plan([ToolSearchTool, deferredTool])
  const restored = await schemas(restoredPlan)
  check('a new process with a missing live tool restores its full wire definition', j(restored) === j(first) && restoredPlan.restoredMissingTools.length === 0)
  const unavailable = gateToolCall([ToolSearchTool, deferredTool] as never, { id: 'missing', name: firstTool.name, argumentsRaw: '{"before":"value"}', malformed: false })
  check('a restored wire definition does not create an executable tool', !unavailable.ok && unavailable.refusal.code === 'unknown-tool')
  check('the same durable record is not duplicated after reconstruction', await boundPrefixRecordToEmit(key, [...messages, persisted] as never, model) === null)
  freshProcess()
  restoreBoundPrefixFromMessages([persisted])
  check('a fork restores definitions under its new conversation identity', j(await schemas(await plan(livePool, 'forked-conversation'))) === j(first))
  const late = tool('LateFixture', 'lookup', 'Late description', true)
  await schemas(await plan([...livePool, late], 'forked-conversation'))
  const expanded = await boundPrefixRecordToEmit('forked-conversation', [...messages, persisted] as never, model)
  check('a newly appended deferred definition updates the durable record', expanded?.attachment.type === 'bound_prefix' && expanded.attachment.roster.some(mark => mark.name === late.name && typeof mark.definition === 'string'))
  freshProcess()
  restoreBoundPrefixFromMessages([persisted, JSON.parse(j(expanded))])
  const expandedRestore = await schemas(await plan(livePool, 'forked-conversation'))
  check('reconstruction uses the newest recorded definition set', expandedRestore.some(t => t.name === late.name) && j(expandedRestore.slice(0, first.length)) === j(first))
  freshProcess()
  const corrupt = JSON.parse(j(persisted))
  corrupt.attachment.roster[0].definition = 'not-json'
  restoreBoundPrefixFromMessages([corrupt])
  check('malformed saved definition data falls back to the live tool without throwing', j(await schemas(await plan(livePool))).includes('Changed description'))
  freshProcess()
  if (saved === undefined) delete process.env.MERCURY_TOOL_SEARCH
  else process.env.MERCURY_TOOL_SEARCH = saved
}

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    interface RunResult { exit: number | null; stdout: string; stderr: string }
    interface Arena { home: string; cwd: string; env: Record<string, string> }
    function makeArena(fixture: FixtureApi, extraEnv: Record<string, string> = {}): Arena {
      const home = mkdtempSync(join(tmpdir(), 'sent-prefix-home-'))
      const cwd = mkdtempSync(join(tmpdir(), 'sent-prefix-cwd-'))
      mkdirSync(join(home, '.claude'), { recursive: true })
      return {
        home,
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.claude'),
          MERCURY_CREDENTIAL_STORE: 'file',
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_TEAMS_DIR: join(home, 'teams'),
          MERCURY_THINKING_BINDING: 'drop_block',
          ...extraEnv,
        },
      }
    }
    function run(arena: Arena, args: string[]): Promise<RunResult> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
      })
    }
    function runStreaming(arena: Arena, args: string[], turns: Array<{ prompt: string; before?: () => void; controls?: Record<string, unknown>[] }>): Promise<RunResult> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        let sent = 0
        let resultsSeen = 0
        const sendNext = (): void => {
          if (sent >= turns.length) {
            child.stdin.end()
            return
          }
          const turn = turns[sent]!
          sent++
          turn.before?.()
          for (const [index, request] of (turn.controls ?? []).entries()) {
            child.stdin.write(j({ type: 'control_request', request_id: `ctl-${sent}-${index}`, request }) + '\n')
          }
          child.stdin.write(j({ type: 'user', message: { role: 'user', content: turn.prompt } }) + '\n')
        }
        child.stdout.on('data', d => {
          stdout += d
          const results = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
          while (resultsSeen < results) {
            resultsSeen++
            sendNext()
          }
        })
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
        child.on('spawn', () => sendNext())
      })
    }
    type Body = { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string; thinking?: { block_binding?: { prefix_mismatch_behavior?: string } } }

    function census(label: string, reqs: ReturnType<FixtureApi['messageRequests']>, expectPrefix: boolean): number[] {
      const diffs: number[] = []
      const models = [...new Set(reqs.map(r => String((r.body as Body).model ?? '')))]
      if (expectPrefix) check(`${label}: one model id on the wire across every request (${models.join(' · ') || 'none'})`, reqs.length > 0 && models.length === 1 && models[0] !== '', models.join(' · '))
      for (let i = 1; i < reqs.length; i++) {
        const prev = reqs[i - 1]!.body as Body
        const cur = reqs[i]!.body as Body
        const systemSame = j(withoutCacheControl(prev.system)) === j(withoutCacheControl(cur.system))
        const toolsSame = j(withoutCacheControl(prev.tools)) === j(withoutCacheControl(cur.tools))
        const pm = (prev.messages ?? []) as unknown[]
        const cm = (cur.messages ?? []) as unknown[]
        let firstDiff = -1
        for (let k = 0; k < pm.length; k++) {
          if (j(withoutCacheControl(pm[k])) !== j(withoutCacheControl(cm[k]))) {
            firstDiff = k
            break
          }
        }
        diffs.push(firstDiff)
        const appended = cm.length > pm.length
        console.log(`    ${label} pair ${i}→${i + 1}: system ${systemSame ? 'same' : 'DIFFERS'} · tools ${toolsSame ? 'same' : 'DIFFERS'} · messages prefix ${firstDiff === -1 ? `same (${pm.length} → ${cm.length})` : `DIFFERS at index ${firstDiff}`}`)
        if (!systemSame) {
          const ps = Array.isArray(prev.system) ? (prev.system as Array<{ text?: string }>) : []
          const cs = Array.isArray(cur.system) ? (cur.system as Array<{ text?: string }>) : []
          for (let b = 0; b < Math.max(ps.length, cs.length); b++) {
            if ((ps[b]?.text ?? '') !== (cs[b]?.text ?? '')) {
              const a = ps[b]?.text ?? ''
              const c = cs[b]?.text ?? ''
              let at = 0
              while (at < a.length && at < c.length && a[at] === c[at]) at++
              console.log(`      system block ${b} differs at char ${at}: ${j(a.slice(Math.max(0, at - 80), at + 160))} vs ${j(c.slice(Math.max(0, at - 80), at + 160))}`)
              break
            }
          }
        }
        if (!toolsSame) {
          const pt = Array.isArray(prev.tools) ? (prev.tools as Array<{ name?: string }>) : []
          const ct = Array.isArray(cur.tools) ? (cur.tools as Array<{ name?: string }>) : []
          console.log(`      tools: ${pt.map(t => t.name).join(',')} → ${ct.map(t => t.name).join(',')}`)
        }
        if (firstDiff !== -1) {
          console.log(`      prev[${firstDiff}]: ${j(withoutCacheControl(pm[firstDiff])).slice(0, 700)}`)
          console.log(`      cur [${firstDiff}]: ${j(withoutCacheControl(cm[firstDiff])).slice(0, 700)}`)
        }
        if (expectPrefix) {
          check(`${label} pair ${i}→${i + 1}: the top-level system is byte-identical`, systemSame)
          check(`${label} pair ${i}→${i + 1}: the tools array is byte-identical`, toolsSame)
          check(`${label} pair ${i}→${i + 1}: the shared messages prefix is byte-identical and the turn is appended`, firstDiff === -1 && appended, `firstDiff=${firstDiff} ${pm.length}→${cm.length}`)
        }
      }
      return diffs
    }
    function transcriptNotices(arena: Arena, sessionId: string): string[] {
      const walk = (dir: string): string[] => {
        const out: string[] = []
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) out.push(...walk(full))
          else if (entry.name === `${sessionId}.jsonl`) out.push(full)
        }
        return out
      }
      const files = existsSync(join(arena.home, '.claude', 'projects')) ? walk(join(arena.home, '.claude', 'projects')) : []
      const notices: string[] = []
      for (const file of files) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes('Preserved thinking')) continue
          try {
            const row = JSON.parse(line) as { payload?: { kind?: string; content?: string } }
            if (row.payload?.kind === 'notice' && typeof row.payload.content === 'string') notices.push(row.payload.content)
          } catch {
          }
        }
      }
      return notices
    }
    const common = ['--model', 'claude-opus-4-8', '--allowed-tools', 'Read', '--output-format', 'stream-json']

    section('manual MCP reconnects apply only the selected schema change')
    {
      const model = 'claude-fable-5-1'
      const toolName = 'mcp__fixture__read_record'
      const fixture = await startFixtureApi([
        { kind: 'tool_use', name: 'ToolSearch', input: { query: `select:${toolName}` }, thinking: 'Load the tool definition.', model },
        { kind: 'text', text: 'MCP-READY', thinking: 'The original tool is available.', model },
        { kind: 'text', text: 'MCP-CHANGED', thinking: 'The requested schema has changed.', model },
        { kind: 'text', text: 'MCP-STABLE', thinking: 'The unchanged reconnect keeps this definition.', model },
      ], { bindingCheck: true })
      try {
        const arena = makeArena(fixture, { MERCURY_TOOL_SEARCH: 'on' })
        const marker = join(arena.cwd, 'schema.txt')
        const server = join(arena.cwd, 'mcp-server.mjs')
        const config = join(arena.cwd, 'mcp.json')
        writeFileSync(marker, 'before')
        writeFileSync(server, `
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
const send = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10))
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  let result = {}
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
  if (message.method === 'tools/list') {
    const field = readFileSync(process.argv[2], 'utf8')
    result = { tools: [{ name: 'read_record', description: 'Read using ' + field, annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { [field]: { type: 'string' } }, required: [field] } }] }
  }
  if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'record' }] }
  send({ jsonrpc: '2.0', id: message.id, result })
})
process.stdin.on('end', () => process.exit(0))
`)
        writeFileSync(config, j({ mcpServers: { fixture: { type: 'stdio', command: nodeBin, args: [server, marker] } } }))
        const sid = 'c0ffee00-0000-4000-8000-00000000c113'
        const result = await new Promise<RunResult>(resolveRun => {
          const child = spawn(nodeBin!, [DIST, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--session-id', sid, '--mcp-config', config, '--strict-mcp-config', '--allowed-tools', 'ToolSearch', toolName], { cwd: arena.cwd, env: arena.env })
          let stdout = ''
          let stderr = ''
          let buffer = ''
          let results = 0
          const send = (value: unknown) => child.stdin.write(j(value) + String.fromCharCode(10))
          const prompt = (content: string) => send({ type: 'user', message: { role: 'user', content } })
          child.stdout.on('data', data => {
            stdout += data
            buffer += data
            let newline: number
            while ((newline = buffer.indexOf(String.fromCharCode(10))) >= 0) {
              const line = buffer.slice(0, newline)
              buffer = buffer.slice(newline + 1)
              let row: Record<string, any>
              try { row = JSON.parse(line) } catch { continue }
              if (row.type === 'result') {
                results++
                if (results === 3) { child.stdin.end(); continue }
                if (results === 1) writeFileSync(marker, 'after')
                send({ type: 'control_request', request_id: `reconnect-${results}`, request: { subtype: 'mcp_reconnect', server_name: 'fixture' } })
              }
              if (row.type === 'control_response' && String(row.response?.request_id ?? '').startsWith('reconnect-')) {
                if (row.response?.subtype !== 'success') { child.stdin.end(); continue }
                prompt(results === 1 ? 'Continue with the changed tool.' : 'Continue with the unchanged tool.')
              }
            }
          })
          child.stderr.on('data', data => { stderr += data })
          const deadline = setTimeout(() => child.kill('SIGKILL'), 90_000)
          child.on('close', exit => { clearTimeout(deadline); resolveRun({ exit, stdout, stderr }) })
          child.on('spawn', () => prompt(`Find ${toolName}, then finish this turn.`))
        })
        check('the real SDK reconnect control settles the changed and unchanged cases', result.exit === 0 && ['MCP-READY', 'MCP-CHANGED', 'MCP-STABLE'].every(text => result.stdout.includes(text)), result.stderr.slice(-600))
        const requests = fixture.messageRequests()
        check('the reconnect sequence makes four requests', requests.length === 4, String(requests.length))
        const definition = (request: typeof requests[number] | undefined) => ((request?.body as { tools?: Array<{ name?: string; input_schema?: unknown }> } | undefined)?.tools ?? []).find(t => t.name === toolName)
        check('the requested reconnect sends the new input schema', j(definition(requests[1]) ?? null).includes('before') && j(definition(requests[2]) ?? null).includes('after'))
        check('the unchanged reconnect keeps exactly the new definition', j(definition(requests[2])) === j(definition(requests[3])))
        check('only the actual schema change drops a bound reasoning block', requests.length === 4 && bindingDropsFor(requests[2]!.body).length > 0 && bindingDropsFor(requests[3]!.body).length === 0)
        const notices = transcriptNotices(arena, sid)
        check('the product attributes that drop to the manual reconnect once', notices.filter(text => text.includes('manually reconnected')).length === 1, j(notices))
        check('no rewrite notice follows the deliberate reconnect', !notices.some(text => text.includes('rewrote already-sent history')), j(notices))
        const doctorRow = existsSync(join(arena.home, '.claude', 'preserved-thinking.json')) ? (JSON.parse(readFileSync(join(arena.home, '.claude', 'preserved-thinking.json'), 'utf8')) as { last?: { kind?: string } }) : null
        check("the doctor row keeps the reconnect's own kind", typeof doctorRow?.last?.kind === 'string' && doctorRow.last.kind !== 'rewrite', j(doctorRow))
      } finally {
        await fixture.close()
      }
    }

    section('mixed streaming and one-shot entry modes keep saved tool definitions')
    {
      const model = 'claude-fable-5-1'
      const fixture = await startFixtureApi([
        { kind: 'text', text: 'MIXED-FIRST', thinking: 'First request.', model },
        { kind: 'text', text: 'MIXED-RESUMED', thinking: 'Resumed request.', model },
        { kind: 'text', text: 'MIXED-RETURNED', thinking: 'Streaming again.', model },
      ], { bindingCheck: true })
      try {
        const arena = makeArena(fixture)
        const sid = 'c0ffee00-0000-4000-8000-00000000c112'
        const args = ['--model', model, '--allowed-tools', 'Read', '--output-format', 'stream-json']
        const first = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...args, '--session-id', sid], [{ prompt: 'Begin without tools.' }])
        const resumed = await run(arena, ['-p', 'Continue without tools.', ...args, '--resume', sid])
        const returned = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...args, '--resume', sid], [{ prompt: 'Continue once more without tools.' }])
        check('all three entry-mode transitions settle successfully', first.exit === 0 && first.stdout.includes('MIXED-FIRST') && resumed.exit === 0 && resumed.stdout.includes('MIXED-RESUMED') && returned.exit === 0 && returned.stdout.includes('MIXED-RETURNED'), [first.stderr, resumed.stderr, returned.stderr].join('\n').slice(-600))
        const requests = fixture.messageRequests()
        check('every transition makes its expected request', requests.length === 3, String(requests.length))
        check('entry-mode changes drop no preserved reasoning', requests.every(request => bindingDropsFor(request.body).length === 0), requests.map(request => bindingDropsFor(request.body).length).join(','))
        census('mixed entry modes', requests, true)
      } finally {
        await fixture.close()
      }
    }

    section('§11 cleared tool results survive later turns, resume and fork')
    {
      const model = 'claude-fable-5-1'
      const turns: ScriptedTurn[] = [
        ...Array.from({ length: 8 }, (_, i) => ({ kind: 'tool_use' as const, name: 'Read', input: {}, thinking: 'Read file ' + i, model })),
        { kind: 'text', text: 'PRUNE-READY', thinking: 'All files read.', model },
        { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'prompt is too long: 202000 tokens > 200000 maximum' },
        { kind: 'text', text: 'PRUNE-APPLIED', thinking: 'Reasoning after clearing.', model },
        { kind: 'text', text: 'PRUNE-NEXT', thinking: 'The following query.', model },
        { kind: 'text', text: 'PRUNE-RESUMED', thinking: 'The restored conversation.', model },
        { kind: 'text', text: 'PRUNE-FORKED', thinking: 'The new conversation.', model },
        { kind: 'text', text: 'PRUNE-FORK-RESUMED', thinking: 'The new conversation resumes.', model },
        { kind: 'text', text: 'PRUNE-CONTINUED', thinking: 'Continue the latest conversation.', model },
      ]
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      try {
        const arena = makeArena(fixture)
        const files = Array.from({ length: 8 }, (_, i) => join(arena.cwd, 'notes-' + i + '.txt'))
        for (const [i, file] of files.entries()) {
          writeFileSync(file, 'Value ' + i + '\n' + 'A fixed reference row retains its original contents across requests.\n'.repeat(75))
          ;(turns[i] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: file }
        }
        const sid = 'c0ffee00-0000-4000-8000-00000000c108'
        const args = ['--model', model, '--allowed-tools', 'Read', '--output-format', 'stream-json']
        const live = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...args, '--session-id', sid], [
          { prompt: 'Read each file in order: ' + files.join(', ') },
          { prompt: 'Continue without tools.' },
          { prompt: 'Continue once more without tools.' },
        ])
        check('§11 the live conversation settles all three turns', live.exit === 0 && ['PRUNE-READY', 'PRUNE-APPLIED', 'PRUNE-NEXT'].every(text => live.stdout.includes(text)), live.stderr.slice(-300))
        const resumed = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...args, '--resume', sid], [{ prompt: 'Continue without tools.' }])
        check('§11 a new process resumes the cleared conversation', resumed.exit === 0 && resumed.stdout.includes('PRUNE-RESUMED'), resumed.stderr.slice(-300))
        const forked = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...args, '--resume', sid, '--fork-session'], [{ prompt: 'Fork and continue without tools.' }])
        const envelopes = forked.stdout.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
          try { return [JSON.parse(line)] } catch { return [] }
        })
        const forkId = envelopes.find(row => row.type === 'result')?.session_id
        check('§11 the fork keeps its own persistent identity', forked.exit === 0 && typeof forkId === 'string' && forkId !== sid && forked.stdout.includes('PRUNE-FORKED'), forked.stderr.slice(-300))
        if (typeof forkId === 'string' && forkId !== sid) {
          const again = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...args, '--resume', forkId], [{ prompt: 'Resume the fork without tools.' }])
          check('§11 the fork persists inherited replacements for its next resume', again.exit === 0 && again.stdout.includes('PRUNE-FORK-RESUMED'), again.stderr.slice(-300))
          const continued = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...args, '--continue'], [{ prompt: 'Continue without tools.' }])
          check('§11 continue restores the same replacement state', continued.exit === 0 && continued.stdout.includes('PRUNE-CONTINUED'), continued.stderr.slice(-300))
        }
        const requests = fixture.messageRequests()
        check('§11 all expected model requests occurred', requests.length === 16, String(requests.length))
        const cleared = requests.slice(10)
        check('§11 the clearing and all subsequent requests retain three placeholders', cleared.length === 6 && cleared.every(request => {
          const body = request.body as Body
          return ((body.messages ?? []) as Array<{ content?: Block[] }>).flatMap(message => Array.isArray(message.content) ? message.content : [])
            .filter(block => block.type === 'tool_result' && typeof block.content === 'string' && block.content.startsWith('[stale tool result')).length === 3
        }))
        check('§11 the binding checker drops no reasoning on any request', requests.every(request => bindingDropsFor(request.body).length === 0), requests.map(request => bindingDropsFor(request.body).length).join(','))
        census('§11 after clearing', cleared, true)
      } finally {
        await fixture.close()
      }
    }


    section('§2 the wire, one process — three turns, a file rewritten on disk between them')
    {
      const turns: ScriptedTurn[] = [
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'plan: read the note' },
        { kind: 'text', text: 'S2-TURN-1-DONE', thinking: 'the note is read', inputTransformations: [] },
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'plan: read it again' },
        { kind: 'text', text: 'S2-TURN-2-DONE', thinking: 'the rewritten note is read', inputTransformations: [] },
        { kind: 'text', text: 'S2-TURN-3-DONE', thinking: 'third', inputTransformations: [] },
      ]
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture)
      const notePath = join(arena.cwd, 'note.txt')
      writeFileSync(notePath, 'first bytes of the note\n')
      ;(turns[0] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: notePath }
      ;(turns[2] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: notePath }
      const SID = 'c0ffee00-0000-4000-8000-00000000c0ff'
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--session-id', SID, '--debug-file', join(arena.home, 's2.debug.log')], [
        { prompt: 'read @note.txt and tell me what it says' },
        { prompt: 'the note changed — read @note.txt again', before: () => writeFileSync(notePath, 'REWRITTEN bytes of the note, longer than before\n') },
        { prompt: 'anything else?' },
      ])
      check('the three-turn process exits 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
      check('every turn answered', r.stdout.includes('S2-TURN-1-DONE') && r.stdout.includes('S2-TURN-2-DONE') && r.stdout.includes('S2-TURN-3-DONE'), r.stdout.slice(0, 300))
      const reqs = fixture.messageRequests()
      check('five message requests (two tool rounds, one plain turn)', reqs.length === 5, String(reqs.length))
      for (let i = 0; i < reqs.length; i++) {
        const body = reqs[i]!.body as Body
        check(`request ${i + 1} carries thinking.block_binding.prefix_mismatch_behavior=drop_block`, body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block', j(body.thinking))
      }
      census('§2', reqs, true)
      const last = ((reqs[reqs.length - 1]?.body as Body)?.messages ?? []) as Array<{ role: string; content: unknown }>
      const thinkingCount = last.reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Block[]).filter(b => b.type === 'thinking').length : 0), 0)
      check('the last request replays every earlier thinking block (four scripted)', thinkingCount === 4, String(thinkingCount))
      check('no drop notice painted anywhere (the scripted lists are empty)', !(r.stdout + r.stderr).includes('reserved thinking'))
      await fixture.close()
    }

    section('§3 the wire, across a resume — the same @-mentioned file, rewritten between processes')
    {
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S3-TURN-1-DONE', thinking: 'read the mention', inputTransformations: [] },
        { kind: 'text', text: 'S3-TURN-2-DONE', thinking: 'read the new mention', inputTransformations: [] },
        { kind: 'text', text: 'S3-TURN-3-DONE', thinking: 'third', inputTransformations: [] },
      ]
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture)
      const notePath = join(arena.cwd, 'note.txt')
      writeFileSync(notePath, 'resume: first bytes\n')
      const SID = 'c0ffee00-0000-4000-8000-00000000c0f3'
      const r1 = await run(arena, ['-p', 'summarize @note.txt', ...common, '--session-id', SID])
      check('turn 1 exit 0', r1.exit === 0, `exit=${r1.exit} stderr=${r1.stderr.slice(0, 300)}`)
      writeFileSync(notePath, 'resume: REWRITTEN bytes, a different length\n')
      const r2 = await run(arena, ['-p', 'and @note.txt now?', ...common, '--resume', SID])
      check('turn 2 (resumed, file rewritten) exit 0', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(0, 300)}`)
      const r3 = await run(arena, ['-p', 'thanks', ...common, '--resume', SID])
      check('turn 3 (resumed) exit 0', r3.exit === 0, `exit=${r3.exit} stderr=${r3.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests()
      check('three message requests', reqs.length === 3, String(reqs.length))
      census('§3', reqs, true)
      const head = j(withoutCacheControl(((reqs[2]?.body as Body)?.messages ?? []).slice(0, 2)))
      check('the first turn still carries the FIRST bytes of the note (and its anchor) on the third request', head.includes('resume: first bytes') && head.includes('(anchor: fa:') && !head.includes('REWRITTEN'), head.slice(0, 300))
      await fixture.close()
    }

    section('§4 the control — compaction moves the prefix lawfully; the receipt names it')
    {
      const DROP = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S4-FAT-DONE', thinking: 'fat turn', usage: { input_tokens: 97_000 } },
        { kind: 'text', text: 'Summary of the session so far: fixture summary body.' },
        { kind: 'text', text: 'S4-POST-COMPACT-DONE', thinking: 'after the fold', inputTransformations: [DROP] },
      ]
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture, { MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '9' })
      const SID = 'c0ffee00-0000-4000-8000-00000000c0f4'
      const debugFile = join(arena.home, 's4.debug.log')
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--session-id', SID, '--debug-file', debugFile], [
        { prompt: 'hi big' },
        { prompt: 'hi after' },
      ])
      check('the two-turn process exits 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
      check('both turns answered around the fold', r.stdout.includes('S4-FAT-DONE') && r.stdout.includes('S4-POST-COMPACT-DONE'), r.stdout.slice(0, 300))
      const reqs = fixture.messageRequests()
      check('three message requests: the fat turn, the summary, the post-compaction turn', reqs.length === 3, String(reqs.length))
      const diffs = census('§4', reqs, false)
      check('the post-compaction request starts from a rewritten messages[0] (the lawful change)', diffs[1] === 0, j(diffs))
      const notices = transcriptNotices(arena, SID)
      check('the scripted drop paints exactly one receipt', notices.length === 1, `${notices.length} ${notices[0]?.slice(0, 200) ?? ''}`)
      const notice = notices[0] ?? ''
      check('…the receipt names compaction as the lawful cause', notice.includes('compaction'), notice.slice(0, 300))
      check('…and never the recurrence wording (nothing unlawful happened)', !notice.includes('rewriting') && !notice.includes('doctor'), notice.slice(0, 300))
      const ledger = join(arena.home, '.claude', 'preserved-thinking.json')
      check('the doctor ledger records the drop with its lawful cause', existsSync(ledger) && readFileSync(ledger, 'utf8').includes('"compaction"') && readFileSync(ledger, 'utf8').includes('messages.1.content.0'), existsSync(ledger) ? readFileSync(ledger, 'utf8').slice(0, 300) : 'absent')
      await fixture.close()
    }

    section('§5 a model switch — the previous model\'s thinking leaves the requests, one quiet receipt; same-model spellings never read as a switch')
    const systemTextOf = (body: Body): string => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(b => b.text ?? '').join('\n') : String(body.system ?? ''))
    const thinkingBlocksOf = (body: Body): number =>
      ((body.messages ?? []) as Array<{ content?: unknown }>).reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Block[]).filter(b => b.type === 'thinking').length : 0), 0)
    const switchArgs = (model: string): string[] => ['--model', model, '--allowed-tools', 'Read', '--output-format', 'stream-json']
    {
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S5-OPUS-1', thinking: 'opus one', model: 'claude-opus-4-8' },
        { kind: 'text', text: 'S5-OPUS-2', thinking: 'opus two', model: 'claude-opus-4-8' },
        { kind: 'text', text: 'S5-FABLE-1', thinking: 'fable one', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'S5-FABLE-2', thinking: 'fable two', model: 'claude-fable-5-1' },
      ]
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture)
      const SID = 'c0ffee00-0000-4000-8000-00000000c0f5'
      const r1 = await run(arena, ['-p', 'first on opus', ...switchArgs('claude-opus-4-8'), '--session-id', SID])
      const r2 = await run(arena, ['-p', 'second on opus', ...switchArgs('claude-opus-4-8'), '--resume', SID])
      const debug3 = join(arena.home, 's5-switch-3.debug.log')
      const debug4 = join(arena.home, 's5-switch-4.debug.log')
      const r3 = await run(arena, ['-p', 'now on fable', ...switchArgs('claude-fable-5-1'), '--resume', SID, '--debug-file', debug3])
      const r4 = await run(arena, ['-p', 'still on fable', ...switchArgs('claude-fable-5-1'), '--resume', SID, '--debug-file', debug4])
      check('four turns exit 0', [r1, r2, r3, r4].every(r => r.exit === 0), [r1, r2, r3, r4].map(r => `${r.exit}:${r.stderr.slice(0, 120)}`).join(' | '))
      const reqs = fixture.messageRequests()
      check('four message requests', reqs.length === 4, String(reqs.length))
      const [q1, q2, q3, q4] = reqs.map(r => r.body as Body)
      check('the opus turns replay their thinking to opus (request 2 carries one block)', q2 !== undefined && thinkingBlocksOf(q2) === 1, String(q2 && thinkingBlocksOf(q2)))
      check('the first fable request carries NONE of the opus thinking (stripped at the assembler)', q3 !== undefined && thinkingBlocksOf(q3) === 0 && q3.model === 'claude-fable-5-1', `${q3?.model} blocks=${q3 && thinkingBlocksOf(q3)}`)
      check('…and its text and tool turns are intact (the opus answers still ride)', q3 !== undefined && j(q3.messages).includes('S5-OPUS-1') && j(q3.messages).includes('S5-OPUS-2'))
      check('the second fable request carries only the fable thinking (one block), the opus blocks still out', q4 !== undefined && thinkingBlocksOf(q4) === 1 && j(q4.messages).includes('fable one'), String(q4 && thinkingBlocksOf(q4)))
      check('the fable requests keep the shared prefix byte-identical (the strip is stable across requests)', q3 !== undefined && q4 !== undefined && j(withoutCacheControl((q3.messages ?? []).slice(0, (q3.messages ?? []).length))) === j(withoutCacheControl((q4.messages ?? []).slice(0, (q3.messages ?? []).length))))
      const debugLines = (file: string): string[] => { try { return readFileSync(file, 'utf8').split('\n').filter(l => l.includes('preserved thinking: Preserved thinking')) } catch { return [] } }
      const receipts3 = debugLines(debug3)
      const receipts4 = debugLines(debug4)
      check('the first fable turn paints exactly one quiet receipt naming the switch (the writer and the new model), never a drop', receipts3.length === 1 && receipts3[0]!.includes('written by') && receipts3[0]!.includes('stay out of the requests to') && receipts3[0]!.includes('switched models') && !receipts3[0]!.includes('dropped'), j(receipts3))
      check('the second fable turn (a new process) paints it once more, never twice (once per switch per process)', receipts4.length === 1, j(receipts4))
      check('no drop notice painted on any turn (the API never saw a foreign block)', !transcriptNotices(arena, SID).some(t => t.includes('dropped')) && !(readFileSync(debug3, 'utf8') + readFileSync(debug4, 'utf8')).includes('thinking_dropped'))
      check('the fixture\'s drop lists stayed empty end to end (nothing for the API to drop)', !(r3.stdout + r4.stdout).includes('thinking_dropped'))
      await fixture.close()
    }
    {
      const legs: Array<{ label: string; spellings: string[]; wire: string }> = [
        { label: 'Claude Fable 5.1', spellings: ['claude-fable-5-1', 'fable51', 'claude-fable-5-1[1m]'], wire: 'claude-fable-5-1' },
        { label: 'Claude Opus 5', spellings: ['claude-opus-5', 'opus5', 'claude-opus-5[1m]'], wire: 'claude-opus-5' },
      ]
      for (const leg of legs) {
        const turns: ScriptedTurn[] = leg.spellings.map((_, i) => ({ kind: 'text' as const, text: `S5-${leg.wire}-${i + 1}`, thinking: `${leg.wire} ${i + 1}`, model: leg.wire }))
        const fixture = await startFixtureApi(turns)
        const arena = makeArena(fixture)
        const SID = `c0ffee00-0000-4000-8000-0000000${leg.wire.includes('fable') ? '0c0f6' : '0c0f7'}`
        const runs: RunResult[] = []
        for (let i = 0; i < leg.spellings.length; i++) {
          runs.push(await run(arena, ['-p', `turn ${i + 1}`, ...switchArgs(leg.spellings[i]!), ...(i === 0 ? ['--session-id', SID] : ['--resume', SID])]))
        }
        check(`${leg.label}: every spelling's turn exits 0`, runs.every(r => r.exit === 0), runs.map(r => `${r.exit}:${r.stderr.slice(0, 100)}`).join(' | '))
        const reqs = fixture.messageRequests()
        check(`${leg.label}: three requests, one wire id (${leg.wire}) whatever the spelling`, reqs.length === 3 && reqs.every(r => (r.body as Body).model === leg.wire), reqs.map(r => String((r.body as Body).model)).join(' · '))
        const last = reqs[2]?.body as Body | undefined
        check(`${leg.label}: the last request replays both earlier thinking blocks (no spelling read as a switch)`, last !== undefined && thinkingBlocksOf(last) === 2, String(last && thinkingBlocksOf(last)))
        census(`§5 ${leg.wire}`, reqs, true)
        const q3 = reqs[2]?.body as Body | undefined
        check(`${leg.label} [1m]: the identity line spells the wire id, never the window suffix`, q3 !== undefined && systemTextOf(q3).includes(`the model you run through Mercury is \`${leg.wire}\``) && !systemTextOf(q3).includes('[1m]') && !systemTextOf(q3).includes('1M context'), systemTextOf(q3).slice(systemTextOf(q3).indexOf('the model you run through'), systemTextOf(q3).indexOf('the model you run through') + 120))
        check(`${leg.label}: no switch receipt, no drop notice`, transcriptNotices(arena, SID).length === 0, j(transcriptNotices(arena, SID)))
        await fixture.close()
      }
    }

    section('§6 the Godot control section — read from the filesystem, frozen for the conversation')
    const toolNamesOf = (body: Body): string[] => (Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map(t => String(t.name)) : [])
    const godotProject = '; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="Fixture"\n'
    {
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S6A-TURN-1', thinking: 'godot a 1', inputTransformations: [] },
        { kind: 'tool_use', name: 'ToolSearch', input: { query: 'select:Godot' }, thinking: 'godot a lookup' },
        { kind: 'tool_use', name: 'Godot', input: { op: 'vulcan_status' }, thinking: 'godot a status' },
        { kind: 'text', text: 'S6A-TURN-2', thinking: 'godot a 2', inputTransformations: [] },
        { kind: 'text', text: 'S6A-TURN-3', thinking: 'godot a 3', inputTransformations: [] },
      ]
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture, { MERCURY_GODOT_TOOLS: '1' })
      const SID = 'c0ffee00-0000-4000-8000-00000000c0f8'
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--session-id', SID], [
        { prompt: 'start a game' },
        { prompt: 'the project exists now — probe the Godot surface', before: () => writeFileSync(join(arena.cwd, 'project.godot'), godotProject) },
        { prompt: 'carry on' },
      ])
      check('§6a three turns exit 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests()
      check('§6a five message requests (turn 2 carries the lookup round and the Godot round)', reqs.length === 5, String(reqs.length))
      census('§6a', reqs, true)
      check('§6a the section stays absent (no project at the first request)', reqs.every(q => !systemTextOf(q.body as Body).includes('Godot control surface')), reqs.map(q => systemTextOf(q.body as Body).includes('Godot control surface')).join(','))
      const offersGodot = (q: { raw: string; body: unknown }): boolean => toolNamesOf(q.body as Body).includes('Godot') || /\\nGodot\\n/.test(q.raw)
      check('§6a the Godot tool is offered from the FIRST request (the flag alone seats it) and on every request across the project\'s birth', reqs.every(offersGodot), reqs.map(offersGodot).join(','))
      const messagesTextOf = (q: { body: unknown }): string => j((q.body as Body).messages ?? [])
      const cwdTail = arena.cwd.slice(arena.cwd.lastIndexOf('/') + 1)
      check('§6a the Godot tool answered vulcan_status for the project born mid-session (callable at once, no compaction needed)', reqs.slice(3).some(q => messagesTextOf(q).includes('flag: armed') && messagesTextOf(q).includes(`project: `) && messagesTextOf(q).includes(cwdTail)), reqs.slice(3).map(q => messagesTextOf(q).includes('flag: armed')).join(','))
      check('§6a no drop notice: the prefix held across the birth', transcriptNotices(arena, SID).length === 0, j(transcriptNotices(arena, SID)))
      await fixture.close()
    }
    {
      const turns: ScriptedTurn[] = [1, 2, 3].map(n => ({ kind: 'text' as const, text: `S6B-TURN-${n}`, thinking: `godot b ${n}`, inputTransformations: [] }))
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture, { MERCURY_GODOT_TOOLS: '1' })
      writeFileSync(join(arena.cwd, 'project.godot'), godotProject)
      const SID = 'c0ffee00-0000-4000-8000-00000000c0f9'
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--session-id', SID], [
        { prompt: 'inspect the scene' },
        { prompt: 'the project file is gone', before: () => rmSync(join(arena.cwd, 'project.godot'), { force: true }) },
        { prompt: 'carry on' },
      ])
      check('§6b three turns exit 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests()
      check('§6b three message requests', reqs.length === 3, String(reqs.length))
      census('§6b', reqs, true)
      const offersGodot = (q: { raw: string; body: unknown }): boolean => toolNamesOf(q.body as Body).includes('Godot') || /\\nGodot\\n/.test(q.raw)
      check('§6b the section rides every request (present at the first one), the Godot tool offered on every request', reqs.length === 3 && reqs.every(q => systemTextOf(q.body as Body).includes('Godot control surface') && offersGodot(q)), reqs.map(q => `${systemTextOf(q.body as Body).includes('Godot control surface')}/${offersGodot(q)}`).join(','))
      await fixture.close()
    }

    section('§6c the resume road — a gate that flips between two processes never rewrites the frozen prefix (the operator\'s Godot session, on the real binding check)')
    const transcriptText = (arena: Arena, sessionId: string): string => {
      const files: string[] = []
      const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === `${sessionId}.jsonl`) files.push(f) } }
      const root = join(arena.home, '.claude', 'projects')
      if (existsSync(root)) walk(root)
      return files.map(f => readFileSync(f, 'utf8')).join('\n')
    }
    {
      const turns: ScriptedTurn[] = [1, 2].map(n => ({ kind: 'text' as const, text: `S6C-T${n}`, thinking: `godot c ${n}` }))
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_THINKING_BINDING: 'error' })
      delete arena.env.MERCURY_GODOT_TOOLS
      const SID = 'c0ffee00-0000-4000-8000-00000000c06c'
      const r1 = await run(arena, ['-p', 'start a game', ...common, '--session-id', SID])
      check('§6c turn 1 (the flag off, no project) exit 0', r1.exit === 0, `exit=${r1.exit} stderr=${r1.stderr.slice(0, 300)}`)
      check('§6c the first exchange record persisted (a bound_prefix attachment)', transcriptText(arena, SID).includes('bound_prefix'), transcriptText(arena, SID).slice(0, 120))
      arena.env.MERCURY_GODOT_TOOLS = '1'
      writeFileSync(join(arena.cwd, 'project.godot'), godotProject)
      const r2 = await run(arena, ['-p', 'inspect the scene', ...common, '--resume', SID])
      check('§6c turn 2 (resumed, the flag armed, the project born) exit 0 — the binding check refused nothing', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(0, 400)}`)
      const reqs = fixture.messageRequests()
      check('§6c two message requests', reqs.length === 2, String(reqs.length))
      const sysA = systemTextOf(reqs[0]!.body as Body)
      const sysB = systemTextOf(reqs[1]!.body as Body)
      check('§6c the first request carried no Godot at all (the control: the flag was off)', !sysA.includes('Godot') && !toolNamesOf(reqs[0]!.body as Body).includes('Godot'), `godotInSystem=${sysA.includes('Godot')}`)
      check('§6c the resumed request never gained the Godot section, doctrine or harness-map line (the system is byte-identical across the resume)', sysA === sysB && !sysB.includes('Godot'), `A=${sysA.length}B B=${sysB.length}B godot=${sysB.includes('Godot')}`)
      check('§6c the resumed bound tools are byte-identical (the Godot tool the flag now seats is a joiner outside the bound prefix)', j(withoutCacheControl(reqs[0]!.body.tools)) === j(withoutCacheControl(reqs[1]!.body.tools)), `${toolNamesOf(reqs[0]!.body as Body).length} → ${toolNamesOf(reqs[1]!.body as Body).length}`)
      check('§6c the fixture refused nothing and the API dropped no thinking block on the resumed request', fixture.refusals.length === 0 && bindingDropsFor(reqs[1]!.body).length === 0, `refusals=${fixture.refusals.length} drops=${bindingDropsFor(reqs[1]!.body).length}`)
      await fixture.close()
    }

    section('§6d the resume road — the git-status snapshot (the last system block) never rewrites across two processes; a tree that moved reaches the model on a new row')
    {
      const turns: ScriptedTurn[] = [1, 2].map(n => ({ kind: 'text' as const, text: `S6D-T${n}`, thinking: `tree ${n}` }))
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_THINKING_BINDING: 'error' })
      const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' }
      const git = (args: string[]): void => { spawnSync('git', args, { cwd: arena.cwd, stdio: 'ignore', env: gitEnv }) }
      writeFileSync(join(arena.cwd, 'README.md'), '# a repository\n')
      git(['init', '-q'])
      git(['add', '.'])
      git(['commit', '-q', '-m', 'seed'])
      const SID = 'c0ffee00-0000-4000-8000-00000000c06d'
      const r1 = await run(arena, ['-p', 'look around', ...common, '--session-id', SID])
      check('§6d turn 1 (a clean repository) exit 0', r1.exit === 0, `exit=${r1.exit} stderr=${r1.stderr.slice(0, 300)}`)
      const reqs1 = fixture.messageRequests()
      const sysA = systemTextOf(reqs1[0]!.body as Body)
      check('§6d the first request appended the git-status snapshot as its last system block', sysA.includes('gitStatus:'), sysA.slice(-200))
      check('§6d the record carries that snapshot', /"systemContext":\{"gitStatus":/.test(transcriptText(arena, SID)) || transcriptText(arena, SID).includes('"gitStatus"'), transcriptText(arena, SID).includes('bound_prefix') ? 'record present, snapshot absent' : 'no record')
      writeFileSync(join(arena.cwd, 'notes.txt'), 'saved between the turns\n')
      const r2 = await run(arena, ['-p', 'and now?', ...common, '--resume', SID])
      check('§6d turn 2 (resumed, the tree moved) exit 0 — the binding check refused nothing', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(0, 400)}`)
      const reqs = fixture.messageRequests()
      check('§6d two message requests', reqs.length === 2, String(reqs.length))
      const sysB = systemTextOf(reqs[1]!.body as Body)
      check('§6d the resumed request re-sent the FIRST snapshot (the system is byte-identical; the saved file is not in the prefix)', sysA === sysB && !sysB.includes('notes.txt'), `A=${sysA.length}B B=${sysB.length}B notes=${sysB.includes('notes.txt')}`)
      check('§6d the fixture refused nothing and the API dropped no thinking block on the resumed request', fixture.refusals.length === 0 && bindingDropsFor(reqs[1]!.body).length === 0, `refusals=${fixture.refusals.length} drops=${bindingDropsFor(reqs[1]!.body).length}`)
      await fixture.close()
    }

    section("§7 the six-request proof — two admissions, apollo→flow, sub-agents off, an effort change, then a compaction: the prefix never moves until the fold; every deferral mark and the summariser's array ride frozen")
    {
      const summary = 'S7 SUMMARY needle: the session found the fetch and browser tools, switched to flow, turned sub-agents off and lowered the effort.'
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S7-T1', thinking: 's7 one', model: 'claude-fable-5-1' },
        { kind: 'tool_use', name: 'ToolSearch', input: { query: 'WebFetch' }, thinking: 's7 lookup one', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'S7-T2', thinking: 's7 two', model: 'claude-fable-5-1' },
        { kind: 'tool_use', name: 'ToolSearch', input: { query: 'Browser' }, thinking: 's7 lookup two', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'S7-T3', thinking: 's7 three', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'S7-T4', thinking: 's7 four (flow)', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'S7-T5', thinking: 's7 five (no sub-agents)', model: 'claude-fable-5-1' },
        { kind: 'text', text: 'S7-T6', thinking: 's7 six (low effort)', usage: { input_tokens: 97_000 }, model: 'claude-fable-5-1' },
        { kind: 'text', text: summary, model: 'claude-fable-5-1' },
        { kind: 'text', text: 'S7-T7', thinking: 's7 seven (after the fold)', model: 'claude-fable-5-1' },
      ]
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture, {
        MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '9',
        MERCURY_CONCOURSE_WORKER: '1',
        MERCURY_TOOL_SEARCH: 'tst',
      })
      const SID = 'c0ffee00-0000-4000-8000-00000000c0fa'
      const debugFile = join(arena.home, 's7.debug.log')
      mkdirSync(join(arena.home, 'daemon'), { recursive: true })
      writeFileSync(join(arena.home, 'daemon', 'concourse-workers.json'), JSON.stringify({
        version: 1,
        workers: {
          'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: SID, workspaceId: arena.cwd, isolation: 'shared', modelKey: 'claude-fable-5-1', spawnedAt: Date.now(), focusedAt: Date.now(), focusedBy: `operator:${process.pid}` },
        },
      }))
      const r = await runStreaming(
        arena,
        ['-p', '--input-format', 'stream-json', '--model', 'claude-fable-5-1', '--allowed-tools', 'ToolSearch,Read', '--permission-mode', 'apollo', '--output-format', 'stream-json', '--session-id', SID, '--debug-file', debugFile],
        [
          { prompt: 'start the interview' },
          { prompt: 'find the fetch tool' },
          { prompt: 'and the browser tool' },
          { prompt: 'carry on in flow', controls: [{ subtype: 'set_permission_mode', mode: 'flow' }] },
          { prompt: 'keep going without sub-agents', controls: [{ subtype: 'spawn_switch', switch: 'subagents', on: false }] },
          { prompt: 'and now at low effort', controls: [{ subtype: 'set_effort', effort: 'low' }] },
          { prompt: 'after the fold' },
        ],
      )
      check('§7 the seven-turn process exits 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
      check('§7 every turn answered around the lookups and the fold', ['S7-T1', 'S7-T2', 'S7-T3', 'S7-T4', 'S7-T5', 'S7-T6', 'S7-T7'].every(t => r.stdout.includes(t)), r.stdout.slice(0, 300))
      const reqs = fixture.messageRequests()
      check('§7 ten message requests (seven turns, two lookup rounds, one summary)', reqs.length === 10, String(reqs.length))
      const beforeFold = reqs.slice(0, 9)
      census('§7 before the fold', beforeFold, true)
      const foldPair = reqs.slice(8, 10)
      const foldDiffs = census('§7 the fold', foldPair, false)
      check('§7 the post-compaction request starts from a rewritten messages[0] (the one lawful change)', foldDiffs[0] === 0, j(foldDiffs))
      const debug = (() => { try { return readFileSync(debugFile, 'utf8') } catch { return '' } })()
      const dropLines = debug.split('\n').filter(l => l.includes('preserved thinking: [{"type":"thinking_dropped"'))
      check('§7 the API-faithful fixture dropped nothing on any request of the session (zero drop lists)', dropLines.length === 0 && !r.stdout.includes('thinking_dropped'), `${dropLines.length} drop line(s)`)
      const notices = transcriptNotices(arena, SID)
      check('§7 no receipt at all — no defect row, no mode row, nothing lawful to report either', notices.length === 0, j(notices))
      check('§7 the apollo-born first request lists ApolloReview (deferred, like every deferrable tool)', toolNamesOf(reqs[0]!.body as Body).includes('ApolloReview'), toolNamesOf(reqs[0]!.body as Body).join(','))
      const toolsOf = (q: { body: unknown }): Array<{ name?: string; defer_loading?: boolean }> => (Array.isArray((q.body as Body).tools) ? ((q.body as Body).tools as Array<{ name?: string; defer_loading?: boolean }>) : [])
      const first = toolsOf(reqs[0]!)
      check('§7 WebFetch and Browser rode the FIRST request deferred (defer_loading) — nothing to add on admission', first.some(t => t.name === 'WebFetch' && t.defer_loading === true) && first.some(t => t.name === 'Browser' && t.defer_loading === true), j(first.filter(t => t.name === 'WebFetch' || t.name === 'Browser')))
      check('§7 the Agent tool rode the first request (the focused seat admits launches) and stays in the tools array with sub-agents off — the toggled request and the summariser alike (the valve refuses; the array never moves)', toolsOf(reqs[0]!).some(t => t.name === 'Agent') && toolsOf(reqs[6]!).some(t => t.name === 'Agent') && toolsOf(reqs[8]!).some(t => t.name === 'Agent'), `first=${toolsOf(reqs[0]!).some(t => t.name === 'Agent')} toggled=${toolsOf(reqs[6]!).some(t => t.name === 'Agent')} summariser=${toolsOf(reqs[8]!).some(t => t.name === 'Agent')}`)
      const admissionRows = beforeFold.filter(q => q.raw.includes('"type":"tool_reference"')).length
      check('§7 the lookups admitted through tool_reference records inside their own result rows', admissionRows >= 2, String(admissionRows))
      const rows = (() => {
        const dir = join(arena.home, '.claude', 'projects')
        const files: string[] = []
        const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === `${SID}.jsonl`) files.push(f) } }
        if (existsSync(dir)) walk(dir)
        return files.map(f => readFileSync(f, 'utf8')).join('\n')
      })()
      check('§7 the apollo pack rode a persisted mode_pack row and left through a mode_pack_exit row (never the system prompt)', rows.includes('"attachmentType":"mode_pack"') && rows.includes('"attachmentType":"mode_pack_exit"') && !systemTextOf(reqs[0]!.body as Body).includes('Apollo Mode'), `${rows.includes('"attachmentType":"mode_pack"')}/${rows.includes('"attachmentType":"mode_pack_exit"')}`)
      const marksOf = (q: { body: unknown }): string => toolsOf(q).map(t => `${t.name}${t.defer_loading === true ? '+' : '-'}`).join(' ')
      console.log(`    §7 tools per request: ${reqs.map((q, i) => `${i + 1}:${toolsOf(q).length}`).join(' ')}`)
      for (let i = 1; i < beforeFold.length; i++) {
        const a = marksOf(beforeFold[i - 1]!).split(' ')
        const b = marksOf(beforeFold[i]!).split(' ')
        const moved = a.filter((m, k) => m !== b[k]).map((m, k) => `${m}→${b[a.indexOf(m)] ?? '∅'}`)
        if (moved.length > 0 || a.length !== b.length) console.log(`      marks moved ${i}→${i + 1}: ${moved.slice(0, 6).join(' ')}${a.length !== b.length ? ` (${a.length} → ${b.length} tools)` : ''}`)
        check(`§7 pair ${i}→${i + 1}: every defer_loading mark is byte-identical (${a.length} tools)`, a.join(' ') === b.join(' '), moved.slice(0, 4).join(' '))
      }
      const swarmMarks = (q: { body: unknown }): string => marksOf(q).split(' ').filter(m => /^(Agent|TeamCreate|LaunchFleet)[+-]$/.test(m)).join(' ')
      check("§7 the swarm tools (TeamCreate, LaunchFleet) rode the FIRST request deferred — the field's tools", first.some(t => t.name === 'TeamCreate' && t.defer_loading === true) && first.some(t => t.name === 'LaunchFleet' && t.defer_loading === true), swarmMarks(reqs[0]!))
      check('§7 the toggle landed in the transcript (a roster_transition notice row) — the mark pins are not vacuous', rows.includes('"noticeKind":"roster_transition"'))
      check('§7 after the toggle the swarm tools are still listed AND still marked deferred (the mark travels with the definition)', toolsOf(reqs[6]!).some(t => t.name === 'TeamCreate' && t.defer_loading === true) && toolsOf(reqs[6]!).some(t => t.name === 'LaunchFleet' && t.defer_loading === true), swarmMarks(reqs[6]!))
      const summariser = reqs[8]!
      check("§7 the fold took the cache-sharing fork road (the field's road on Fable 5.1)", debug.includes('forkedAgent(compact)'), debug.split('\n').filter(l => l.includes('compact')).slice(0, 3).join(' | ').slice(0, 300))
      check("§7 the summariser's tools array is the conversation's, byte for byte (the fork rides the parent's frozen roster)", j(withoutCacheControl((summariser.body as Body).tools)) === j(withoutCacheControl((reqs[7]!.body as Body).tools)) && marksOf(summariser) === marksOf(reqs[7]!), `${toolsOf(summariser).length} vs ${toolsOf(reqs[7]!).length} tools; summariser ${swarmMarks(summariser)} vs conversation ${swarmMarks(reqs[7]!)}`)
      check("§7 the summariser's system prompt is the conversation's", j(withoutCacheControl((summariser.body as Body).system)) === j(withoutCacheControl((reqs[7]!.body as Body).system)))
      await fixture.close()
    }

    section('§8 a model switch mid-conversation continues — Fable 5.1 → Opus 5 → Fable 5.1 with thinking and tool turns between: every request legal, one quiet receipt per switch, prefixes frozen')
    {
      const FABLE = 'claude-fable-5-1'
      const OPUS = 'claude-opus-5'
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S8-F1', thinking: 'fable one', model: FABLE },
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'fable reads', model: FABLE },
        { kind: 'text', text: 'S8-F2', thinking: 'fable two', model: FABLE },
        { kind: 'text', text: 'S8-O1', thinking: 'opus one', model: OPUS },
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'opus reads', model: OPUS },
        { kind: 'text', text: 'S8-O2', thinking: 'opus two', model: OPUS },
        { kind: 'text', text: 'S8-F3', thinking: 'fable three', model: FABLE },
        { kind: 'text', text: 'S8-F4', thinking: 'fable four', model: FABLE },
      ]
      const fixture = await startFixtureApi(turns, { bindingCheck: true, apiChecks: true })
      const arena = makeArena(fixture, { MERCURY_TOOL_SEARCH: 'tst' })
      const notePath = join(arena.cwd, 'note.txt')
      writeFileSync(notePath, 'switch leg note\n')
      ;(turns[1] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: notePath }
      ;(turns[4] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: notePath }
      const SID = 'c0ffee00-0000-4000-8000-00000000c0fb'
      const debugFile = join(arena.home, 's8.debug.log')
      const r = await runStreaming(
        arena,
        ['-p', '--input-format', 'stream-json', '--model', FABLE, '--allowed-tools', 'Read', '--output-format', 'stream-json', '--session-id', SID, '--debug-file', debugFile],
        [
          { prompt: 'first on fable' },
          { prompt: 'read the note' },
          { prompt: 'now on opus', controls: [{ subtype: 'set_model', model: OPUS }] },
          { prompt: 'read it again on opus' },
          { prompt: 'back on fable', controls: [{ subtype: 'set_model', model: FABLE }] },
          { prompt: 'still on fable' },
        ],
      )
      check('§8 the six-turn process exits 0 (no stall: every turn answered within the run budget)', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
      check('§8 every turn answered on both models', ['S8-F1', 'S8-F2', 'S8-O1', 'S8-O2', 'S8-F3', 'S8-F4'].every(t => r.stdout.includes(t)), r.stdout.slice(0, 300))
      const reqs = fixture.messageRequests()
      check('§8 eight message requests (two tool rounds) and NOT ONE refused by the API\'s own checks', reqs.length === 8 && fixture.refusals.length === 0, `${reqs.length} requests; refusals=${j(fixture.refusals)}`)
      const bodies = reqs.map(q => q.body as Body)
      check('§8 the wire model follows the switch: fable · fable · fable · opus · opus · opus · fable · fable', j(bodies.map(b => b.model)) === j([FABLE, FABLE, FABLE, OPUS, OPUS, OPUS, FABLE, FABLE]), j(bodies.map(b => b.model)))
      const opusFirst = reqs[3]!
      const opusBody = opusFirst.body as Body & { max_tokens?: number; output_config?: unknown; betas?: unknown }
      const assistantShapes = ((opusBody.messages ?? []) as Array<{ role?: string; content?: unknown }>).filter(m => m.role === 'assistant').map(m => (Array.isArray(m.content) ? (m.content as Block[]).map(b => b.type).join('+') : typeof m.content))
      console.log(`    §8 capture — the first Opus request: model=${opusBody.model} max_tokens=${String(opusBody.max_tokens)} thinking=${j(opusBody.thinking)} output_config=${j(opusBody.output_config)} betas=${opusFirst.headers['anthropic-beta'] ?? ''} assistant turns=${j(assistantShapes)}`)
      check('§8 the first Opus request carries NONE of the Fable thinking (stripped) and every assistant turn keeps legal content (text or tool_use, never empty)', thinkingBlocksOf(opusBody) === 0 && assistantShapes.length === 3 && assistantShapes.every(s => s.length > 0 && !s.includes('thinking')), j(assistantShapes))
      check('§8 max_tokens on the Opus request is within its cap (the switch re-resolves the target\'s limits)', typeof opusBody.max_tokens === 'number' && opusBody.max_tokens <= 128_000, String(opusBody.max_tokens))
      const fableBack = reqs[6]!.body as Body
      check('§8 back on Fable: the Opus thinking is stripped and the Fable blocks from before the switch replay (three: two turns plus the tool round)', thinkingBlocksOf(fableBack) === 3 && j(fableBack.messages).includes('fable one') && j(fableBack.messages).includes('fable reads') && !j(fableBack.messages).includes('opus one'), String(thinkingBlocksOf(fableBack)))
      census('§8 fable', reqs.slice(0, 3), true)
      census('§8 opus', reqs.slice(3, 6), true)
      census('§8 fable again', reqs.slice(6, 8), true)
      const crossSwitch = census('§8 across the switch', [reqs[2]!, reqs[3]!], false)
      console.log(`    §8 across the switch: first messages diff at ${j(crossSwitch)} (the thinking strip; not prefix)`)
      const debug = (() => { try { return readFileSync(debugFile, 'utf8') } catch { return '' } })()
      const switchReceipts = debug.split('\n').filter(l => l.includes('preserved thinking: Preserved thinking') && l.includes('switched models'))
      check('§8 exactly two quiet switch receipts (one per real switch)', switchReceipts.length === 2, `${switchReceipts.length} receipt(s)`)
      check('§8 the API-faithful fixture dropped nothing across both switches (the foreign blocks left before the wire; the returning blocks bind to their own prefix)', !debug.includes('thinking_dropped') && !r.stdout.includes('thinking_dropped'))
      const problemRows = transcriptNotices(arena, SID).filter(t => t.includes('dropped') || /error/i.test(t)).length
      check('§8 no drop notice, no API error row and no stall words in the transcript', problemRows === 0 && !r.stdout.includes('no stream events'), String(problemRows))
      await fixture.close()
    }

    section("§9 a running sub-agent through the main's fold — its own prefix never moves, the API-faithful fixture drops nothing under the error behaviour, and its landing during the fold is delivered once, after the boundary")
    {
      const FABLE = 'claude-fable-5-1'
      const SEAT_ALIAS = 'opus'
      const SEAT = 'claude-opus-5'
      const SEAT_DESCRIPTION = 'prefix-seat'
      const summary = 'S9 SUMMARY needle: the main launched the seat and folded.'
      const turns: ScriptedTurn[] = [
        { kind: 'tool_use', name: 'Agent', input: { description: SEAT_DESCRIPTION, prompt: 'prefix-seat: run three short shells, one per turn, then report in one line', subagent_type: 'mercury-general', run_in_background: true, model: SEAT_ALIAS }, thinking: 's9 launch', usage: { input_tokens: 97_000 }, model: FABLE, whenModel: 'fable' },
        { kind: 'paced', deltas: [summary], gapMs: 0, startDelayMs: 7000, whenModel: 'fable' },
        { kind: 'text', text: 'S9-POST', thinking: 's9 after the fold', model: FABLE, whenModel: 'fable' },
        { kind: 'text', text: 'S9-NOTED', thinking: 's9 noted', model: FABLE, whenModel: 'fable' },
        { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 1' }, thinking: 'seat one', model: SEAT, whenModel: 'opus' },
        { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 1' }, thinking: 'seat two', model: SEAT, whenModel: 'opus' },
        { kind: 'tool_use', name: 'Bash', input: { command: 'sleep 1' }, thinking: 'seat three', model: SEAT, whenModel: 'opus' },
        { kind: 'text', text: 'S9-SEAT-DONE', thinking: 'seat done', model: SEAT, whenModel: 'opus' },
      ]
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_THINKING_BINDING: 'error', MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '9' })
      const SID = 'c0ffee00-0000-4000-8000-00000000c0fc'
      const debugFile = join(arena.home, 's9.debug.log')
      const r = await runStreaming(
        arena,
        ['-p', '--input-format', 'stream-json', '--model', FABLE, '--dangerously-bypass-permissions', '--output-format', 'stream-json', '--session-id', SID, '--debug-file', debugFile],
        [{ prompt: 'launch the seat and carry on' }],
      )
      check('§9 the process exits 0 (the turn held for the seat, the fold ran, the notice turn landed)', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
      check('§9 the main answered after the fold and after the notice', r.stdout.includes('S9-POST') && r.stdout.includes('S9-NOTED'), r.stdout.slice(0, 300))
      const debugText = (() => { try { return readFileSync(debugFile, 'utf8') } catch { return '' } })()
      const reqs = fixture.messageRequests()
      const modelOf = (q: { body: unknown }): string => String((q.body as Body).model ?? '')
      const seatReqs = reqs.filter(q => modelOf(q).includes('opus'))
      const mainReqs = reqs.filter(q => modelOf(q).includes('fable'))
      console.log(`    §9 wire order: ${reqs.map((q, i) => `${i + 1}:${modelOf(q).includes('opus') ? 'seat' : 'main'}`).join(' ')}`)
      check('§9 eight requests: four from the seat, four from the main (the launch, the summary, the post-fold turn, the notice turn)', reqs.length === 8 && seatReqs.length === 4 && mainReqs.length === 4, `${reqs.length} total; seat ${seatReqs.length}; main ${mainReqs.length}`)
      check(`§9 the seat rode the resolved id on the wire (${SEAT})`, seatReqs.length > 0 && seatReqs.every(q => modelOf(q) === SEAT), seatReqs.map(modelOf).join(','))
      check('§9 the fold took the cache-sharing fork road', debugText.includes('forkedAgent(compact)'))
      const summaryIndex = reqs.findIndex(q => modelOf(q).includes('fable') && j((q.body as Body).messages).includes('Reply with prose only'))
      const postIndex = reqs.findIndex((q, i) => i > summaryIndex && modelOf(q).includes('fable'))
      const seatIndexes = reqs.map((q, i) => (modelOf(q).includes('opus') ? i : -1)).filter(i => i >= 0)
      check("§9 the seat's rounds ran through the fold (two or more seat requests between the summary request and the post-fold request)", summaryIndex > 0 && postIndex > summaryIndex && seatIndexes.filter(i => i > summaryIndex && i < postIndex).length >= 2, `summary@${summaryIndex + 1} post@${postIndex + 1} seat@${seatIndexes.map(i => i + 1).join(',')}`)
      census('§9 the seat', seatReqs, true)
      const seatLast = seatReqs[seatReqs.length - 1]?.body as Body | undefined
      check("§9 the seat's last request carries no thinking block (a thinking-off seat declares none and sends none)", seatLast !== undefined && thinkingBlocksOf(seatLast) === 0, String(seatLast && thinkingBlocksOf(seatLast)))
      check('§9 the API-faithful fixture REFUSED nothing under the error behaviour (0 dropped blocks, 0 refusals) — the seat never saw a rewritten prefix', fixture.refusals.length === 0 && !debugText.includes('thinking_dropped') && !r.stdout.includes('thinking_dropped'), j(fixture.refusals))
      check("§9 every one of the main's requests carried the error behaviour on the wire", mainReqs.every(q => (q.body as Body).thinking?.block_binding?.prefix_mismatch_behavior === 'error'), reqs.map(q => String((q.body as Body).thinking?.block_binding?.prefix_mismatch_behavior)).join(','))
      const lastSeatIndex = seatIndexes[seatIndexes.length - 1] ?? -1
      check("§9 the seat's final request landed during the fold (before the post-fold request)", lastSeatIndex > summaryIndex && lastSeatIndex < postIndex, `seat last@${lastSeatIndex + 1} post@${postIndex + 1}`)
      const noticeReqs = mainReqs.filter(q => {
        const messages = ((q.body as Body).messages ?? []) as Array<{ role?: string; content?: unknown }>
        const last = [...messages].reverse().find(m => m.role === 'user')
        return j(last?.content ?? '').includes('task-notification') && j(last?.content ?? '').includes(SEAT_DESCRIPTION)
      })
      check("§9 exactly one request carried the seat's completion notice", noticeReqs.length === 1, String(noticeReqs.length))
      const noticeFirst = j(((noticeReqs[0]?.body as Body | undefined)?.messages ?? [])[0] ?? '')
      check('§9 …delivered after the boundary: the notice turn starts from the summary row', noticeFirst.includes('The context window turned over') && noticeFirst.includes('S9 SUMMARY needle'), noticeFirst.slice(0, 200))
      check('§9 …and the notice carries the seat\'s report', j((noticeReqs[0]?.body as Body | undefined)?.messages ?? []).includes('S9-SEAT-DONE'))
      const postPair = reqs.slice(postIndex).filter(q => modelOf(q).includes('fable'))
      census('§9 the post-fold pair', postPair, true)
      check('§9 the roster attachment rode the post-fold request naming the seat, and it was delivered once (the pair is a prefix)', j((postPair[0]?.body as Body | undefined)?.messages ?? []).includes('Agents in flight at the context turnover') && j((postPair[0]?.body as Body | undefined)?.messages ?? []).includes(SEAT_DESCRIPTION))
      check('§9 no drop notice in the transcript', !transcriptNotices(arena, SID).some(t => t.includes('dropped')), j(transcriptNotices(arena, SID)))
      await fixture.close()
    }

    section("§10 a three-agent dispatch — the sent tool_use blocks are byte-identical on every later request of the main, whatever the launches resolved")
    for (const background of [true, false]) {
      const FABLE = 'claude-opus-5'
      const SEAT_ALIAS = 'sonnet'
      const SEAT = 'claude-sonnet-5'
      const tag = background ? 'background' : 'foreground'
      const seatCall = (n: number): { name: string; input: Record<string, unknown> } => ({
        name: 'Agent',
        input: { description: `prefix-wave-${n}`, prompt: `prefix-wave: report one line and stop (${n})`, subagent_type: 'mercury-general', run_in_background: background, model: SEAT_ALIAS },
      })
      const turns: ScriptedTurn[] = [
        { kind: 'paced_tool_use', preDeltas: ['Dispatching the first wave of three agents.'], gapMs: 0, tools: [seatCall(1), seatCall(2), seatCall(3)], whenModel: 'opus' },
        { kind: 'text', text: 'S10-DISPATCHED', thinking: 's10 dispatched', model: FABLE, whenModel: 'opus' },
        { kind: 'text', text: 'S10-NOTED-1', thinking: 's10 noted one', model: FABLE, whenModel: 'opus' },
        { kind: 'text', text: 'S10-NOTED-2', thinking: 's10 noted two', model: FABLE, whenModel: 'opus' },
        { kind: 'text', text: 'S10-NOTED-3', thinking: 's10 noted three', model: FABLE, whenModel: 'opus' },
        { kind: 'text', text: 'S10-NOTED-4', thinking: 's10 noted four', model: FABLE, whenModel: 'opus' },
        { kind: 'text', text: 'S10-NOTED-5', thinking: 's10 noted five', model: FABLE, whenModel: 'opus' },
        { kind: 'text', text: 'S10-NOTED-6', thinking: 's10 noted six', model: FABLE, whenModel: 'opus' },
        { kind: 'text', text: 'S10-SEAT-DONE', thinking: 'seat done', model: SEAT, whenModel: 'sonnet' },
        { kind: 'text', text: 'S10-SEAT-DONE', thinking: 'seat done', model: SEAT, whenModel: 'sonnet' },
        { kind: 'text', text: 'S10-SEAT-DONE', thinking: 'seat done', model: SEAT, whenModel: 'sonnet' },
      ]
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_THINKING_BINDING: 'error' })
      const SID = background ? 'c0ffee00-0000-4000-8000-00000000c10a' : 'c0ffee00-0000-4000-8000-00000000c10b'
      const debugFile = join(arena.home, `s10-${tag}.debug.log`)
      const r = await runStreaming(
        arena,
        ['-p', '--input-format', 'stream-json', '--model', FABLE, '--dangerously-bypass-permissions', '--output-format', 'stream-json', '--session-id', SID, '--debug-file', debugFile],
        [{ prompt: 'dispatch three agents and carry on' }, { prompt: 'and now say noted' }],
      )
      check(`§10 ${tag}: the process exits 0`, r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
      check(`§10 ${tag}: the main answered after the dispatch`, r.stdout.includes('S10-DISPATCHED'), r.stdout.slice(0, 300))
      const debugText = (() => { try { return readFileSync(debugFile, 'utf8') } catch { return '' } })()
      const reqs = fixture.messageRequests()
      const modelOf = (q: { body: unknown }): string => String((q.body as Body).model ?? '')
      const mainReqs = reqs.filter(q => modelOf(q).includes('opus'))
      const seatReqs = reqs.filter(q => modelOf(q).includes('sonnet'))
      console.log(`    §10 ${tag} wire order: ${reqs.map((q, i) => `${i + 1}:${modelOf(q).includes('sonnet') ? 'seat' : 'main'}`).join(' ')}`)
      check(`§10 ${tag}: three seat requests and at least three from the main (the dispatch, the answer after the launches, the notices)`, seatReqs.length === 3 && mainReqs.length >= 3, `main ${mainReqs.length}; seat ${seatReqs.length}`)
      const dispatchRowOf = (q: { body: unknown }): { index: number; row: unknown } | null => {
        const messages = ((q.body as Body).messages ?? []) as Array<{ role?: string; content?: unknown }>
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i]!
          if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
          const tools = m.content.filter(b => (b as { type?: string }).type === 'tool_use' && (b as { name?: string }).name === 'Agent')
          if (tools.length === 3) return { index: i, row: m }
        }
        return null
      }
      const dispatchRows = mainReqs.slice(1).map(dispatchRowOf)
      check(`§10 ${tag}: every main request after the dispatch carries the dispatch row (three Agent tool_use blocks)`, dispatchRows.length >= 2 && dispatchRows.every(d => d !== null), j(dispatchRows.map(d => d?.index ?? null)))
      const bytesOf = (row: unknown): string => j(withoutCacheControl(row))
      const first = dispatchRows[0] !== null ? bytesOf(dispatchRows[0]!.row) : ''
      const moved = dispatchRows.map((d, i) => (d === null ? `#${i + 2}: absent` : bytesOf(d.row) === first ? null : `#${i + 2}: ${firstDiff(first, bytesOf(d.row))}`)).filter((x): x is string => x !== null)
      check(`§10 ${tag}: the dispatch row is byte-identical on every later request — the launches resolved nothing INTO the sent blocks`, moved.length === 0, moved.join(' | '))
      const inputsOf = (row: unknown): string[] => ((row as { content?: Array<{ type?: string; input?: unknown }> }).content ?? []).filter(b => b.type === 'tool_use').map(b => j(b.input))
      check(`§10 ${tag}: each tool_use input keeps the exact keys the model sent (no resolved type, model or effort added; no key reordered)`, dispatchRows.every(d => d !== null && inputsOf(d.row).every(input => input === j(seatCall(1).input).replace('prefix-wave-1', input.includes('prefix-wave-2') ? 'prefix-wave-2' : input.includes('prefix-wave-3') ? 'prefix-wave-3' : 'prefix-wave-1').replace('(1)', input.includes('(2)') ? '(2)' : input.includes('(3)') ? '(3)' : '(1)'))), j(dispatchRows[0] !== null ? inputsOf(dispatchRows[0]!.row) : []))
      census(`§10 ${tag} the main`, mainReqs, true)
      check(`§10 ${tag}: the API-faithful fixture REFUSED nothing under the error behaviour and no drop notice rode`, fixture.refusals.length === 0 && !debugText.includes('thinking_dropped') && !r.stdout.includes('thinking_dropped') && !debugText.includes('names a rewrite of sent history'), j(fixture.refusals) + ' ' + (debugText.includes('names a rewrite') ? 'ledger named a rewrite' : ''))
      await fixture.close()
    }
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ SENT PREFIX FROZEN GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} SENT PREFIX FAILURE(S) (${checks} checks)`)
process.exit(1)
