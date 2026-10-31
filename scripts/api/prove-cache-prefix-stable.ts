#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runTurns } from '../lib/rows.ts'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cache-prefix-stable-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL

import { handoffTurn, isHandoffRequest, startFixtureApi, type CapturedRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const MODEL = 'claude-fable-5-1'

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
  console.log('\n❌ TIMEOUT — the cache prefix proof exceeded 280s')
  process.exit(1)
}, 280_000)
guard.unref?.()

type Body = {
  model?: string
  system?: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  messages?: Array<{ role: string; content: unknown }>
  thinking?: unknown
  output_config?: unknown
  tool_choice?: unknown
  betas?: unknown
  metadata?: unknown
  diagnostics?: { previous_message_id: string | null }
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

function markers(body: Body): Array<{ at: string; ttl: string }> {
  const out: Array<{ at: string; ttl: string }> = []
  const spell = (cc: unknown): string => j(cc)
  for (const [i, block] of (body.system ?? []).entries()) if (block.cache_control !== undefined) out.push({ at: `system[${i}]`, ttl: spell(block.cache_control) })
  for (const [i, tool] of (body.tools ?? []).entries()) if (tool.cache_control !== undefined) out.push({ at: `tools[${i}]`, ttl: spell(tool.cache_control) })
  for (const [m, row] of (body.messages ?? []).entries()) {
    if (!Array.isArray(row.content)) continue
    for (const [b, block] of (row.content as Array<Record<string, unknown>>).entries()) if (block.cache_control !== undefined) out.push({ at: `messages[${m}].content[${b}]`, ttl: spell(block.cache_control) })
  }
  return out
}

function firstDiffAt(a: string, b: string): number {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return at
}

function excerpt(text: string, at: number): string {
  return j(text.slice(Math.max(0, at - 80), at + 160))
}

interface PairVerdict { held: boolean; where: string; before: string; after: string }

function prefixHeld(prev: Body, cur: Body): PairVerdict {
  const ps = j(prev.system)
  const cs = j(cur.system)
  if (ps !== cs) {
    const at = firstDiffAt(ps, cs)
    return { held: false, where: `system (serialized, cache_control included) @char ${at}`, before: excerpt(ps, at), after: excerpt(cs, at) }
  }
  const pt = j(prev.tools)
  const ct = j(cur.tools)
  if (pt !== ct) {
    const at = firstDiffAt(pt, ct)
    return { held: false, where: `tools (serialized) @char ${at}`, before: excerpt(pt, at), after: excerpt(ct, at) }
  }
  const pm = prev.messages ?? []
  const cm = cur.messages ?? []
  if (cm.length <= pm.length) return { held: false, where: `messages.length (${pm.length} → ${cm.length}): the history did not grow`, before: '', after: '' }
  for (let k = 0; k < pm.length; k++) {
    const a = j(withoutCacheControl(pm[k]))
    const b = j(withoutCacheControl(cm[k]))
    if (a !== b) {
      const at = firstDiffAt(a, b)
      return { held: false, where: `messages[${k}] @char ${at}`, before: excerpt(a, at), after: excerpt(b, at) }
    }
  }
  return { held: true, where: '', before: '', after: '' }
}

function promptAffecting(body: Body): string {
  return j({ model: body.model, thinking: body.thinking, output_config: body.output_config, tool_choice: body.tool_choice, betas: body.betas, metadata: body.metadata })
}

function census(label: string, requests: CapturedRequest[], all: CapturedRequest[], opts: { expectBreakBefore?: Set<number> } = {}): void {
  const bodies = requests.map(q => q.body as Body)
  const responseIdOf = (request: CapturedRequest): string => `msg_fixture_${all.indexOf(request) + 1}`
  check(`${label}: at least three requests captured`, bodies.length >= 3, String(bodies.length))
  for (let i = 1; i < bodies.length; i++) {
    const prev = bodies[i - 1]!
    const cur = bodies[i]!
    const verdict = prefixHeld(prev, cur)
    const expectBreak = opts.expectBreakBefore?.has(i) === true
    if (expectBreak) {
      check(`${label} #${i}→#${i + 1}: the lawful break lands where expected (${verdict.where || 'no break'})`, !verdict.held)
      continue
    }
    check(`${label} #${i}→#${i + 1}: request ${i + 1} starts with the whole serialized prefix of request ${i} (system, tools, every shared message)`, verdict.held, `${verdict.where}\n      before: ${verdict.before}\n      after:  ${verdict.after}`)
    check(`${label} #${i}→#${i + 1}: the prompt-affecting parameters are identical (model, thinking, output_config, tool_choice, betas, metadata)`, promptAffecting(prev) === promptAffecting(cur), `${promptAffecting(prev)} vs ${promptAffecting(cur)}`)
  }
  for (const [i, body] of bodies.entries()) {
    const marks = markers(body)
    const ttls = new Set(marks.map(m => m.ttl))
    const lastMessage = (body.messages ?? []).length - 1
    const lastBlocks = Array.isArray(body.messages?.[lastMessage]?.content) ? (body.messages![lastMessage]!.content as unknown[]).length : 1
    const systemMarks = marks.filter(m => m.at.startsWith('system['))
    const messageMarks = marks.filter(m => m.at.startsWith('messages['))
    check(`${label} request ${i + 1}: breakpoints sit on the last system block and the last block of the last message, nowhere else, all with one TTL`,
      systemMarks.length === 1 && systemMarks[0]!.at === `system[${(body.system ?? []).length - 1}]` && messageMarks.length === 1 && messageMarks[0]!.at === `messages[${lastMessage}].content[${lastBlocks - 1}]` && marks.filter(m => m.at.startsWith('tools[')).length === 0 && ttls.size === 1,
      j(marks))
  }
  check(`${label}: the first request opts into cache diagnostics with previous_message_id null`, bodies[0]?.diagnostics !== undefined && bodies[0]?.diagnostics?.previous_message_id === null, j(bodies[0]?.diagnostics))
  for (let i = 1; i < bodies.length; i++) {
    const expected = responseIdOf(requests[i - 1]!)
    check(`${label} request ${i + 1}: diagnostics.previous_message_id names the previous response (${expected})`, bodies[i]?.diagnostics?.previous_message_id === expected, j(bodies[i]?.diagnostics))
  }
}

function makeArena(fixtureUrl: string, nodeBin: string, extraEnv: Record<string, string> = {}): { home: string; cwd: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), 'cache-prefix-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'cache-prefix-cwd-'))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  writeFileSync(join(cwd, 'note.txt'), 'line one\nline two\nline three\n')
  writeFileSync(join(home, '.mercury', 'settings.json'), j({ guardrails: { allow: ['Bash(echo *)', 'Read', 'Edit', 'Write', 'ToolSearch', 'Retain'] } }))
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixtureUrl,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_TOOL_SEARCH: 'tst',
      MERCURY_CACHE_DIAGNOSTICS: '1',
      ...extraEnv,
    },
  }
}

const T = (text: string): ScriptedTurn => ({ kind: 'text', text, thinking: `think ${text}`, model: MODEL })
const U = (name: string, input: Record<string, unknown>): ScriptedTurn => ({ kind: 'tool_use', name, input, thinking: `think ${name}`, model: MODEL })

section('§1 the pure law: the diagnostics field, the previous id and the cold-prefix reading')
{
  const { cacheDiagnosticsParam, previousProviderMessageId, describeCacheDiagnostics, cacheMissReasonOf } = await import('../../src/services/providers/anthropic/cacheDiagnostics.ts')
  check('the previous id is the newest provider message id in the wire (synthetic ids skipped)', previousProviderMessageId(['msg_01A', null, 'not-a-provider-id', 'msg_02B', null]) === 'msg_02B' && previousProviderMessageId([null, 'a-uuid']) === null)
  check('the main thread on the first-party road opts in; the first request carries null', j(cacheDiagnosticsParam([], 'main_thread', () => true)) === j({ previous_message_id: null }))
  check('a side request (the summariser) does not opt in', cacheDiagnosticsParam(['msg_01A'], 'compact', () => true) === null)
  const saved = process.env.MERCURY_CACHE_DIAGNOSTICS
  delete process.env.MERCURY_CACHE_DIAGNOSTICS
  check('a gateway road does not opt in by itself (the field is the Claude API\'s)', cacheDiagnosticsParam(['msg_01A'], 'main_thread', () => false) === null)
  process.env.MERCURY_CACHE_DIAGNOSTICS = '1'
  check('MERCURY_CACHE_DIAGNOSTICS=1 sends the field on any road, the previous id named', j(cacheDiagnosticsParam(['msg_01A'], 'main_thread', () => false)) === j({ previous_message_id: 'msg_01A' }))
  process.env.MERCURY_CACHE_DIAGNOSTICS = '0'
  check('MERCURY_CACHE_DIAGNOSTICS=0 turns the field off', cacheDiagnosticsParam(['msg_01A'], 'main_thread', () => true) === null)
  if (saved === undefined) delete process.env.MERCURY_CACHE_DIAGNOSTICS
  else process.env.MERCURY_CACHE_DIAGNOSTICS = saved
  const changed = { diagnostics: { cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 41850 } } }
  check('a *_changed reason is read with its token estimate', cacheMissReasonOf(changed)?.type === 'messages_changed' && describeCacheDiagnostics(changed, { cache_read_input_tokens: 27000, cache_creation_input_tokens: 41850 }) === 'cache diagnostics: messages_changed, ~41850 tokens after the divergence (cache read 27000 · written 41850)')
  check('a null diagnostics field is "no divergence"; an absent field says nothing; a pending comparison is named', describeCacheDiagnostics({ diagnostics: null }, undefined) === 'cache diagnostics: no divergence from the previous request (cache read 0 · written 0)' && describeCacheDiagnostics({}, undefined) === null && describeCacheDiagnostics({ diagnostics: { cache_miss_reason: null } }, undefined) === 'cache diagnostics: comparison pending (cache read 0 · written 0)')
}

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const arenas: Array<{ home: string; cwd: string }> = []
    section('§2 one conversation, every trigger: tool rounds, a ToolSearch admission, an edit, a memory save — then a new process resumes it')
    {
      const turns: ScriptedTurn[] = [
        U('Bash', { command: 'echo hello' }), T('S2-T1'),
        U('Read', { file_path: 'note.txt' }), U('Bash', { command: 'echo two' }), T('S2-T2'),
        U('ToolSearch', { query: 'select:WebFetch' }), T('S2-T3'),
        U('Edit', { file_path: 'note.txt', old_string: 'line two', new_string: 'line 2' }), T('S2-T4'),
        U('ToolSearch', { query: 'select:Retain' }), U('Retain', { topic: 'preferences', fact: 'the operator prefers short answers', why: 'the operator asked' }), T('S2-T5'),
        U('Bash', { command: 'echo six' }), T('S2-T6'),
        U('Read', { file_path: 'note.txt' }), T('S2-T7'),
        T('S2-T8'),
      ]
      const fixture = await startFixtureApi([...turns, ...Array.from({ length: 8 }, () => handoffTurn())], { bindingCheck: true })
      const arena = makeArena(fixture.url, nodeBin)
      arenas.push(arena)
      const sid = 'c0ffee00-0000-4000-8000-00000000cafe'
      const debugFile = join(arena.home, 'prefix.debug.log')
      const args = ['--model', MODEL, '--allowed-tools', 'Bash,Read,Edit,ToolSearch,Retain', '--log-file', debugFile]
      const first = await runTurns({ node: nodeBin, dist: DIST, args: [...args, '--session-id', sid], cwd: arena.cwd, env: arena.env, timeoutMs: 150_000, turns: ['drive turn 1', 'drive turn 2', 'drive turn 3', 'drive turn 4', 'drive turn 5'] })
      check('the first process answers five turns and exits 0', first.exit === 0 && ['S2-T1', 'S2-T2', 'S2-T3', 'S2-T4', 'S2-T5'].every(t => first.stdout.includes(t)), `exit=${first.exit} ${first.stderr.slice(-400)}`)
      const resumed = await runTurns({ node: nodeBin, dist: DIST, args: [...args, '--resume', sid], cwd: arena.cwd, env: arena.env, timeoutMs: 150_000, turns: ['drive turn 6', 'drive turn 7', 'drive turn 8'] })
      check('the resumed process answers three more turns and exits 0', resumed.exit === 0 && ['S2-T6', 'S2-T7', 'S2-T8'].every(t => resumed.stdout.includes(t)), `exit=${resumed.exit} ${resumed.stderr.slice(-400)}`)
      await fixture.close()
      const requests = fixture.messageRequests().filter(q => !isHandoffRequest(q))
      check('seventeen main requests (eight turns, nine tool rounds), none refused by the fixture\'s binding check', requests.length === 17 && fixture.refusals.length === 0, `${requests.length} requests; refusals=${j(fixture.refusals)}`)
      const firstBody = requests[0]?.body as Body | undefined
      check('tool search is on for the run: the first request defers tools (defer_loading) and lists ToolSearch', (firstBody?.tools ?? []).some(t => t.defer_loading === true) && (firstBody?.tools ?? []).some(t => t.name === 'ToolSearch'), `${(firstBody?.tools ?? []).filter(t => t.defer_loading === true).length} deferred`)
      const admission = requests.find(q => q.raw.includes('"tool_reference"'))
      check('the ToolSearch admission rode a tool_reference block inside its own result row (the tools array never moved for it)', admission !== undefined)
      census('§2', requests, fixture.messageRequests())
      const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''
      check('the product\'s own ledger saw no rewrite of sent history in either process', !debug.includes('names a rewrite of sent history'), debug.split('\n').filter(l => l.includes('rewrite of sent history')).slice(0, 2).join(' | '))
    }

    section('§3 a thinking-bearing conversation with an idle gap under five minutes keeps the prefix (the clock alone never moves a byte)')
    {
      const turns: ScriptedTurn[] = [U('Bash', { command: 'echo a' }), T('S3-T1'), T('S3-T2'), T('S3-T3')]
      const fixture = await startFixtureApi([...turns, ...Array.from({ length: 4 }, () => handoffTurn())], { bindingCheck: true })
      const arena = makeArena(fixture.url, nodeBin)
      arenas.push(arena)
      const r = await runTurns({ node: nodeBin, dist: DIST, args: ['--model', MODEL, '--allowed-tools', 'Bash', '--session-id', 'c0ffee00-0000-4000-8000-00000000c0de'], cwd: arena.cwd, env: arena.env, timeoutMs: 120_000, settleMs: 1_500, turns: ['drive turn 1', 'drive turn 2', 'drive turn 3'] })
      check('three turns with settle gaps exit 0', r.exit === 0, `exit=${r.exit} ${r.stderr.slice(-300)}`)
      await fixture.close()
      const requests = fixture.messageRequests().filter(q => !isHandoffRequest(q))
      check('four main requests', requests.length === 4, String(requests.length))
      census('§3', requests, fixture.messageRequests())
    }

    for (const arena of arenas) {
      rmSync(arena.home, { recursive: true, force: true })
      rmSync(arena.cwd, { recursive: true, force: true })
    }
  }
}

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(`\nprove-cache-prefix-stable: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
