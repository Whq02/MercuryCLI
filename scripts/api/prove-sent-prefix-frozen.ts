#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-sent-prefix-frozen.ts — sent messages never change.
//
//  Claude Fable 5.1 binds every thinking block to the exact prefix that
//  produced it (the top-level system, the tools array, every earlier
//  message). A harness that rewrites anything already sent loses every
//  block after the rewrite on the next request. The law this prover pins:
//  the prefix of request N+1 up to the last turn of request N is
//  byte-identical to request N — system, tools and the shared messages —
//  and only the three lawful changes move it (compaction, a deliberate
//  model switch, an operator transcript edit).
//
//    §1 the projection law (pure) — appended rows (a `!` line's local
//       command, an attachment, a prompt) extend the API view; the earlier
//       view is a byte-identical prefix. The aggregate tool-result budget
//       decides a result on first sight and never rewrites a sent one.
//    §2 the wire, one process — three turns through the stream-json input
//       road (the interactive session's shape: one process, the system
//       prompt rebuilt per submit, the attachment producers per turn): a
//       tool round reading a file, the file rewritten on disk between
//       turns and @-mentioned again, then a plain turn. Every consecutive
//       pair is byte-identical up to the appended turn.
//    §3 the wire, across a resume — the same file @-mentioned in two
//       processes with a rewrite between them.
//    §4 the control — compaction (the fixture's usage trips autocompact)
//       moves the prefix lawfully; a drop scripted on the post-compaction
//       response paints the one-line receipt that names compaction, never
//       the recurrence notice.
//
//  Requires the prebuilt dist for §2–§4. Run:
//    ~/.bun/bin/bun run scripts/api/prove-sent-prefix-frozen.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sent-prefix-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

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

/** cache_control markers may move freely (the docs' table). */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = withoutCacheControl(v)
    }
    return out
  }
  return value
}
/** The wire view of a projected message: the fields the request carries. */
function wireOf(m: unknown): string {
  const row = m as { message?: { role?: string; content?: unknown } }
  return j(withoutCacheControl({ role: row.message?.role, content: row.message?.content }))
}

// ============================================================================
section('§1 the projection law — appended rows extend the view, never rewrite it')
// ============================================================================
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

  // A conversation as the turn machine holds it: the user-context row rides
  // in front of the first prompt (it bubbles to the top: no stopping point
  // above it) and coalesces into messages[0].
  const h1 = [ctxRow(), user('first prompt')]
  const p1 = normalizeMessagesForAPI(h1 as never)
  check('turn 1 projects to one user turn carrying the context row and the prompt', p1.length === 1 && wireOf(p1[0]).includes('be brief') && wireOf(p1[0]).includes('first prompt'), wireOf(p1[0]).slice(0, 200))

  // Turn 2: the reply, a `!` line's local-command row, a fresh attachment
  // (a changed file's notice), the second prompt.
  const h2 = [...h1, assistant([THINK('one'), TEXT('a')]), localCommand('ls output'), attachmentRow({ type: 'edited_text_file', filename: '/x/note.txt', snippet: '1: new bytes' }), user('second prompt')]
  const p2 = normalizeMessagesForAPI(h2 as never)
  const pre2 = isPrefix(p1, p2)
  check('turn 2: the turn-1 view is a byte-identical prefix (the `!` row and the attachment ride the NEW user turn)', pre2.ok && p2.length === 3, `at=${pre2.at} rows=${p2.length}`)
  check('…the `!` output and the file notice sit in the last user turn, after the reply', wireOf(p2[2]).includes('ls output') && wireOf(p2[2]).includes('new bytes') && wireOf(p2[2]).includes('second prompt'), wireOf(p2[2]).slice(0, 300))

  // Turn 3: a tool round in between (tool_result user turns are stopping
  // points too), then another attachment and prompt.
  const h3 = [...h2, assistant([THINK('two'), { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x/note.txt' } }]), user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'bytes' }]), assistant([THINK('three'), TEXT('b')]), attachmentRow({ type: 'user_context', body: REMINDER + '\n<!-- newer -->' }), user('third prompt')]
  const p3 = normalizeMessagesForAPI(h3 as never)
  const pre3 = isPrefix(p2, p3)
  check('turn 3: the turn-2 view is a byte-identical prefix across a tool round', pre3.ok && p3.length === 7, `at=${pre3.at} rows=${p3.length}`)
  check('…a fresh user-context copy rides the tail turn; messages[0] keeps the first copy', wireOf(p3[0]) === wireOf(p1[0]) && wireOf(p3[6]).includes('newer'), wireOf(p3[6]).slice(0, 200))

  // A `!` line BEFORE the first prompt coalesces into messages[0] and stays.
  const b1 = [localCommand('early ls'), ctxRow(), user('first prompt')]
  const q1 = normalizeMessagesForAPI(b1 as never)
  const q2 = normalizeMessagesForAPI([...b1, assistant([THINK('one'), TEXT('a')]), user('second prompt')] as never)
  check('a `!` line before the first prompt is part of messages[0] on every later request', q1.length === 1 && isPrefix(q1, q2).ok && wireOf(q2[0]).includes('early ls'), wireOf(q2[0]).slice(0, 200))

  // The aggregate tool-result budget: a result decided on first sight is
  // frozen — a later request with the same history returns the earlier
  // rows by reference (no rewrite of a sent turn).
  const big = 'x'.repeat(400_000)
  const state = createContentReplacementState()
  const round = [user('read it'), assistant([{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'cat big' } }]), user([{ type: 'tool_result', tool_use_id: 'toolu_big', content: big }])]
  const first = await enforceToolResultBudget(round as never, state)
  check('an oversized result is decided on first sight (replaced in the turn it arrives)', first.replacements.length === 1 && !wireOf(first.messages[2]).includes(big), `replacements=${first.replacements.length}`)
  const later = await enforceToolResultBudget([...first.messages, assistant([THINK('x'), TEXT('ok')]), user('next')] as never, state)
  check('the budget never rewrites a result it already decided (the sent turn is byte-identical, nothing new recorded)', wireOf(later.messages[2]) === wireOf(first.messages[2]) && later.replacements.length === 0, `replacements=${later.replacements.length}`)
}

// ============================================================================
section('§1b the tool roster freeze (pure) — a latched decision holds; a joiner rides deferred or is held')
// ============================================================================
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

  // The flip the freeze prevents: servers pending at the first request keep
  // ToolSearch in the roster; once they land with nothing deferred, a plan
  // with no latch turns search off (ToolSearch leaves — a tools edit).
  const free1 = await plan([search, readTool], { pending: true })
  const free2 = await plan([search, readTool], { pending: false })
  check('control (no latch): pending servers ⇒ search on; landed with nothing deferred ⇒ off — the roster moves', free1.enabled && !free2.enabled && names(free1) !== names(free2), `${names(free1)} → ${names(free2)}`)

  const deferrable = fakeTool('Browser', { shouldDefer: true })
  const p1 = await plan([search, readTool, deferrable], { pending: true, key: 'conv-a' })
  const p2 = await plan([search, readTool, deferrable], { pending: false, key: 'conv-a' })
  check('latched: the first request decided search on; the servers landing leaves the roster byte-identical', p1.enabled && p2.enabled && names(p1) === names(p2), `${names(p1)} → ${names(p2)}`)
  check('THE ROSTER LAW: a deferrable tool rides the roster from the FIRST request (deferred on the wire), never held back for an admission', names(p1) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'Browser']) && p1.deferredNames.has('Browser') && !p1.admittedNames.has('Browser'), names(p1))
  check('…the latch records the decision and the names it saw, in order', toolRosterLatchFor('conv-a', [], 'claude-opus-4-8')?.enabled === true && j(toolRosterLatchFor('conv-a', [], 'claude-opus-4-8')?.names) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'Browser']))
  // An admission (a tool_reference inside a ToolSearch result row) changes
  // NOTHING in the roster: the definition was on the wire from request 1.
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
  // Another conversation of the SAME owner (a different first row — a new
  // chat in the process, or the summary row after a compaction) decides fresh.
  const other = [user('another chat')]
  const o1 = await planToolPayload({ model: 'claude-opus-4-8', tools: [search, readTool, mcpTool] as never, messages: other as never, getToolPermissionContext: async () => ({ ...getEmptyToolPermissionContext(), mode: 'default' as never }), agents: [], hasPendingMcpServers: false, source: 'prove', latchKey: 'conv-a' })
  check('a different first row under the same owner keys its own latch (a new chat, or the post-compaction summary)', toolRosterLatchFor('conv-a', other as never, 'claude-opus-4-8') !== undefined && toolRosterLatchFor('conv-a', other as never, 'claude-opus-4-8') !== toolRosterLatchFor('conv-a', [], 'claude-opus-4-8') && o1.deferredNames.has('mcp__srv__late'), names(o1))
  const p4 = await plan([search, readTool, mcpTool], { pending: false, key: 'conv-b' })
  check('another conversation decides for itself (its first request sees the joiner)', p4.deferredNames.has('mcp__srv__late') && names(p4) === j([TOOL_SEARCH_TOOL_NAME, 'Read', 'mcp__srv__late']), names(p4))

  // Search off by policy (a defined-falsy MERCURY_TOOL_SEARCH is the
  // standard mode): everything rides in full from the first request (no
  // ToolSearch); a joiner is HELD out of the frozen roster.
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
  // A compaction or /clear needs no clear at all: the summary row is a new
  // first row, so the same owner keys a fresh latch (pinned above with
  // "a different first row under the same owner").
  const s5 = await plan([search, readTool, late], {})
  check('no latch key ⇒ no latch (a one-off caller decides fresh)', names(s5) === j(['Read', 'LateBuiltin']) && toolRosterLatchFor('undefined', [], 'claude-opus-4-8') === undefined, names(s5))

  // The lawful-change seam moves nothing on the wire: the latch stays, the
  // declaration is pending for the classifier only.
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

// ============================================================================
//  The wire legs — the real artifact against the fixture API.
// ============================================================================
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
          // The fixture host is not first-party: the explicit value puts
          // the field and the header on this wire.
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
    /**
     * One process, several turns over the stream-json input road: each
     * prompt is written after the previous turn's result envelope, with an
     * optional hook between turns (the operator editing a file on disk).
     */
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
          // Control requests (a mode change, a spawn switch, an effort change)
          // ride the same stdin ahead of the turn's prompt.
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

    /** The docs' step-1 capture: consecutive pairs, byte-identical up to the appended turns. */
    function census(label: string, reqs: ReturnType<FixtureApi['messageRequests']>, expectPrefix: boolean): number[] {
      const diffs: number[] = []
      // The model id on the wire is byte-stable across a seat's requests: a
      // moving spelling (an alias one turn, the canonical id the next, a
      // suffix, a variant) would read as a model switch on every request.
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
    /** The "Preserved thinking" receipts persisted in a session's transcript (notice rows). */
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
            // not a row
          }
        }
      }
      return notices
    }
    const common = ['--model', 'claude-opus-4-8', '--allowedTools', 'Read', '--output-format', 'stream-json', '--verbose']

    // ------------------------------------------------------------------------
    section('§2 the wire, one process — three turns, a file rewritten on disk between them')
    // ------------------------------------------------------------------------
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

    // ------------------------------------------------------------------------
    section('§3 the wire, across a resume — the same @-mentioned file, rewritten between processes')
    // ------------------------------------------------------------------------
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

    // ------------------------------------------------------------------------
    section('§4 the control — compaction moves the prefix lawfully; the receipt names it')
    // ------------------------------------------------------------------------
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
      // The receipt is a transcript row (the operator's record), not a
      // stream-json envelope: read it off the session file.
      const notices = transcriptNotices(arena, SID)
      check('the scripted drop paints exactly one receipt', notices.length === 1, `${notices.length} ${notices[0]?.slice(0, 200) ?? ''}`)
      const notice = notices[0] ?? ''
      check('…the receipt names compaction as the lawful cause', notice.includes('compaction'), notice.slice(0, 300))
      check('…and never the recurrence wording (nothing unlawful happened)', !notice.includes('rewriting') && !notice.includes('doctor'), notice.slice(0, 300))
      const ledger = join(arena.home, '.claude', 'preserved-thinking.json')
      check('the doctor ledger records the drop with its lawful cause', existsSync(ledger) && readFileSync(ledger, 'utf8').includes('"compaction"') && readFileSync(ledger, 'utf8').includes('messages.1.content.0'), existsSync(ledger) ? readFileSync(ledger, 'utf8').slice(0, 300) : 'absent')
      await fixture.close()
    }

    // ------------------------------------------------------------------------
    section('§5 a model switch — the previous model\'s thinking leaves the requests, one quiet receipt; same-model spellings never read as a switch')
    // ------------------------------------------------------------------------
    const systemTextOf = (body: Body): string => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(b => b.text ?? '').join('\n') : String(body.system ?? ''))
    const thinkingBlocksOf = (body: Body): number =>
      ((body.messages ?? []) as Array<{ content?: unknown }>).reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Block[]).filter(b => b.type === 'thinking').length : 0), 0)
    const switchArgs = (model: string): string[] => ['--model', model, '--allowedTools', 'Read', '--output-format', 'stream-json', '--verbose']
    {
      // Opus 4.8 wrote two turns; the seat switches to Claude Fable 5.1.
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
      // The receipt is an info-level system row: the operator's transcript
      // paints it; the debug log carries its text on the headless road.
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
      // The same model under its alias spellings: no strip, no receipt, the
      // wire id is the canonical one on every request and the whole prefix
      // holds — Claude Fable 5.1 and Claude Opus 5. The context-window
      // spelling (`[1m]`) is a window, not a model: the identity line spells
      // the wire id, so the pair is byte-identical in system, tools and
      // messages too, and the thinking replays.
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
        // The exact id, its alias and its 1M-context spelling: the whole
        // prefix holds across all three.
        census(`§5 ${leg.wire}`, reqs, true)
        const q3 = reqs[2]?.body as Body | undefined
        check(`${leg.label} [1m]: the identity line spells the wire id, never the window suffix`, q3 !== undefined && systemTextOf(q3).includes(`the model you run through Mercury is \`${leg.wire}\``) && !systemTextOf(q3).includes('[1m]') && !systemTextOf(q3).includes('1M context'), systemTextOf(q3).slice(systemTextOf(q3).indexOf('the model you run through'), systemTextOf(q3).indexOf('the model you run through') + 120))
        check(`${leg.label}: no switch receipt, no drop notice`, transcriptNotices(arena, SID).length === 0, j(transcriptNotices(arena, SID)))
        await fixture.close()
      }
    }

    // ------------------------------------------------------------------------
    section('§6 the Godot control section — read from the filesystem, frozen for the conversation')
    // ------------------------------------------------------------------------
    const toolNamesOf = (body: Body): string[] => (Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map(t => String(t.name)) : [])
    const godotProject = '; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="Fixture"\n'
    {
      // No project at boot; the model (or the operator) creates one before
      // turn 2: the system prompt and the tools array must not move.
      const turns: ScriptedTurn[] = [1, 2, 3].map(n => ({ kind: 'text' as const, text: `S6A-TURN-${n}`, thinking: `godot a ${n}`, inputTransformations: [] }))
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture, { MERCURY_GODOT_TOOLS: '1' })
      const SID = 'c0ffee00-0000-4000-8000-00000000c0f8'
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--session-id', SID], [
        { prompt: 'start a game' },
        { prompt: 'the project exists now', before: () => writeFileSync(join(arena.cwd, 'project.godot'), godotProject) },
        { prompt: 'carry on' },
      ])
      check('§6a three turns exit 0', r.exit === 0, `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests()
      check('§6a three message requests', reqs.length === 3, String(reqs.length))
      census('§6a', reqs, true)
      check('§6a the section stays absent (no project at the first request) and the Godot tool never enters the tools array', reqs.every(q => !systemTextOf(q.body as Body).includes('Godot control surface') && !toolNamesOf(q.body as Body).includes('Godot')), reqs.map(q => toolNamesOf(q.body as Body).includes('Godot')).join(','))
      // The tool that mounted when the project appeared is deferrable: it may
      // be OFFERED from then on, and only through a new deferred-tools row
      // (the first request never carried it; the census above proved the
      // earlier rows unchanged).
      check('§6a the first request never offered the Godot tool; a later offer rides a new row only', !/\\nGodot\\n/.test(reqs[0]!.raw), reqs.map(q => /\\nGodot\\n/.test(q.raw)).join(','))
      await fixture.close()
    }
    {
      // A project at boot: the section and the tool ride every request; the
      // project file vanishing before turn 2 moves nothing.
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
      // The Godot tool is deferrable: it rides the deferred-tools announcement
      // (a persisted row in the first turn), not the tools array, until a
      // ToolSearch admits it — either way it is offered on every request.
      const offersGodot = (q: { raw: string; body: unknown }): boolean => toolNamesOf(q.body as Body).includes('Godot') || /\\nGodot\\n/.test(q.raw)
      check('§6b the section rides every request (present at the first one), the Godot tool offered on every request', reqs.length === 3 && reqs.every(q => systemTextOf(q.body as Body).includes('Godot control surface') && offersGodot(q)), reqs.map(q => `${systemTextOf(q.body as Body).includes('Godot control surface')}/${offersGodot(q)}`).join(','))
      await fixture.close()
    }

    // ------------------------------------------------------------------------
    section('§7 the six-request proof — two admissions, apollo→flow, sub-agents off, an effort change, then a compaction: the prefix never moves until the fold')
    // ------------------------------------------------------------------------
    {
      const summary = 'S7 SUMMARY needle: the session found the fetch and browser tools, switched to flow, turned sub-agents off and lowered the effort.'
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S7-T1', thinking: 's7 one' },
        { kind: 'tool_use', name: 'ToolSearch', input: { query: 'WebFetch' }, thinking: 's7 lookup one' },
        { kind: 'text', text: 'S7-T2', thinking: 's7 two' },
        { kind: 'tool_use', name: 'ToolSearch', input: { query: 'Browser' }, thinking: 's7 lookup two' },
        { kind: 'text', text: 'S7-T3', thinking: 's7 three' },
        { kind: 'text', text: 'S7-T4', thinking: 's7 four (flow)' },
        { kind: 'text', text: 'S7-T5', thinking: 's7 five (no sub-agents)' },
        { kind: 'text', text: 'S7-T6', thinking: 's7 six (low effort)', usage: { input_tokens: 97_000 } },
        { kind: 'text', text: summary },
        { kind: 'text', text: 'S7-T7', thinking: 's7 seven (after the fold)' },
      ]
      // The fixture replays the API's own binding check on every response.
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture, {
        MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '9',
        // The apollo entry rides the concourse-worker door (the SDK door
        // refuses apollo; the worker role accepts it — the field's road).
        MERCURY_CONCOURSE_WORKER: '1',
        // The block form on the fixture host: an explicit search value is
        // the operator's assertion that the gateway carries the beta form —
        // the first-party wire's shape (deferred tools, tool_reference).
        MERCURY_TOOL_SEARCH: 'tst',
      })
      const SID = 'c0ffee00-0000-4000-8000-00000000c0fa'
      const debugFile = join(arena.home, 's7.debug.log')
      const r = await runStreaming(
        arena,
        ['-p', '--input-format', 'stream-json', '--model', 'claude-opus-4-8', '--allowedTools', 'ToolSearch,Read', '--permission-mode', 'apollo', '--output-format', 'stream-json', '--verbose', '--session-id', SID, '--debug-file', debugFile],
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
      // Every pair before the fold: byte-identical system, tools and prefix.
      const beforeFold = reqs.slice(0, 9)
      census('§7 before the fold', beforeFold, true)
      const foldPair = reqs.slice(8, 10)
      const foldDiffs = census('§7 the fold', foldPair, false)
      check('§7 the post-compaction request starts from a rewritten messages[0] (the one lawful change)', foldDiffs[0] === 0, j(foldDiffs))
      // The fixture's replayed binding check: nothing dropped on ANY request —
      // the prefix never moved before the fold, and the fold leaves no
      // earlier thinking block behind to drop (the summary carries none).
      const debug = (() => { try { return readFileSync(debugFile, 'utf8') } catch { return '' } })()
      const dropLines = debug.split('\n').filter(l => l.includes('preserved thinking: [{"type":"thinking_dropped"'))
      check('§7 the API-faithful fixture dropped nothing on any request of the session (zero drop lists)', dropLines.length === 0 && !r.stdout.includes('thinking_dropped'), `${dropLines.length} drop line(s)`)
      const notices = transcriptNotices(arena, SID)
      check('§7 no receipt at all — no defect row, no mode row, nothing lawful to report either', notices.length === 0, j(notices))
      // Ruling 3's detail: the apollo-born conversation lists the review
      // tool from its FIRST request and the mode switch leaves the array
      // byte-identical (the census above); a tool the mode forbids is
      // listed and refuses at call time.
      check('§7 the apollo-born first request lists ApolloReview (deferred, like every deferrable tool)', toolNamesOf(reqs[0]!.body as Body).includes('ApolloReview'), toolNamesOf(reqs[0]!.body as Body).join(','))
      // The roster law on the wire: the admitted tools sat deferred in the
      // tools array from the first request; the array is the same object
      // shape on every request before the fold.
      const toolsOf = (q: { body: unknown }): Array<{ name?: string; defer_loading?: boolean }> => (Array.isArray((q.body as Body).tools) ? ((q.body as Body).tools as Array<{ name?: string; defer_loading?: boolean }>) : [])
      const first = toolsOf(reqs[0]!)
      check('§7 WebFetch and Browser rode the FIRST request deferred (defer_loading) — nothing to add on admission', first.some(t => t.name === 'WebFetch' && t.defer_loading === true) && first.some(t => t.name === 'Browser' && t.defer_loading === true), j(first.filter(t => t.name === 'WebFetch' || t.name === 'Browser')))
      check('§7 the Agent tool stays in the tools array with sub-agents off (the valve refuses; the array never moves)', toolsOf(reqs[8]!).some(t => t.name === 'Agent') === toolsOf(reqs[0]!).some(t => t.name === 'Agent'))
      const admissionRows = beforeFold.filter(q => q.raw.includes('"type":"tool_reference"')).length
      check('§7 the lookups admitted through tool_reference records inside their own result rows', admissionRows >= 2, String(admissionRows))
      // The mode pack rode rows: the pack in the first turn, an exit row after the switch.
      const rows = (() => {
        const dir = join(arena.home, '.claude', 'projects')
        const files: string[] = []
        const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === `${SID}.jsonl`) files.push(f) } }
        if (existsSync(dir)) walk(dir)
        return files.map(f => readFileSync(f, 'utf8')).join('\n')
      })()
      check('§7 the apollo pack rode a persisted mode_pack row and left through a mode_pack_exit row (never the system prompt)', rows.includes('"attachmentType":"mode_pack"') && rows.includes('"attachmentType":"mode_pack_exit"') && !systemTextOf(reqs[0]!.body as Body).includes('Apollo Mode'), `${rows.includes('"attachmentType":"mode_pack"')}/${rows.includes('"attachmentType":"mode_pack_exit"')}`)
      await fixture.close()
    }

    // ------------------------------------------------------------------------
    section('§8 a model switch mid-conversation continues — Fable 5.1 → Opus 5 → Fable 5.1 with thinking and tool turns between: every request legal, one quiet receipt per switch, prefixes frozen')
    // ------------------------------------------------------------------------
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
      // The fixture replays the API's refusals AND its binding check.
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
        ['-p', '--input-format', 'stream-json', '--model', FABLE, '--allowedTools', 'Read', '--output-format', 'stream-json', '--verbose', '--session-id', SID, '--debug-file', debugFile],
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
      // THE CAPTURE — the request Opus received (for the receipt).
      const opusFirst = reqs[3]!
      const opusBody = opusFirst.body as Body & { max_tokens?: number; output_config?: unknown; betas?: unknown }
      const assistantShapes = ((opusBody.messages ?? []) as Array<{ role?: string; content?: unknown }>).filter(m => m.role === 'assistant').map(m => (Array.isArray(m.content) ? (m.content as Block[]).map(b => b.type).join('+') : typeof m.content))
      console.log(`    §8 capture — the first Opus request: model=${opusBody.model} max_tokens=${String(opusBody.max_tokens)} thinking=${j(opusBody.thinking)} output_config=${j(opusBody.output_config)} betas=${opusFirst.headers['anthropic-beta'] ?? ''} assistant turns=${j(assistantShapes)}`)
      check('§8 the first Opus request carries NONE of the Fable thinking (stripped) and every assistant turn keeps legal content (text or tool_use, never empty)', thinkingBlocksOf(opusBody) === 0 && assistantShapes.length === 3 && assistantShapes.every(s => s.length > 0 && !s.includes('thinking')), j(assistantShapes))
      check('§8 max_tokens on the Opus request is within its cap (the switch re-resolves the target\'s limits)', typeof opusBody.max_tokens === 'number' && opusBody.max_tokens <= 128_000, String(opusBody.max_tokens))
      const fableBack = reqs[6]!.body as Body
      check('§8 back on Fable: the Opus thinking is stripped and the Fable blocks from before the switch replay (three: two turns plus the tool round)', thinkingBlocksOf(fableBack) === 3 && j(fableBack.messages).includes('fable one') && j(fableBack.messages).includes('fable reads') && !j(fableBack.messages).includes('opus one'), String(thinkingBlocksOf(fableBack)))
      // Prefixes: byte-identical on the same model, stable across the switch
      // too (system and tools frozen; only the thinking strip differs, and
      // thinking is not part of the prefix — the fixture's binding check).
      census('§8 fable', reqs.slice(0, 3), true)
      census('§8 opus', reqs.slice(3, 6), true)
      census('§8 fable again', reqs.slice(6, 8), true)
      // Across the switch the system prompt moves (the identity line names
      // the model — the deliberate switch) and the thinking strip differs;
      // thinking is not part of the prefix, so the API-faithful fixture
      // drops nothing: the Fable blocks were minted under the Fable prefix
      // and come back to it byte-identical.
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
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ SENT PREFIX FROZEN GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} SENT PREFIX FAILURE(S) (${checks} checks)`)
process.exit(1)
