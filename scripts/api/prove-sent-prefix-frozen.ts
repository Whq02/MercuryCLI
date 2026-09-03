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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    function runStreaming(arena: Arena, args: string[], turns: Array<{ prompt: string; before?: () => void }>): Promise<RunResult> {
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
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ SENT PREFIX FROZEN GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} SENT PREFIX FAILURE(S) (${checks} checks)`)
process.exit(1)
