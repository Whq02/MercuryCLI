#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { arenaPath } from '../lib/platformPath.ts'
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

function makeArena(fixtureUrl: string, nodeBin: string, extraEnv: Record<string, string> = {}, seat: 'key' | 'claude.ai' = 'key'): { home: string; cwd: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), 'cache-prefix-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'cache-prefix-cwd-'))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  writeFileSync(join(cwd, 'note.txt'), 'line one\nline two\nline three\n')
  writeFileSync(join(home, '.mercury', 'settings.json'), j({ guardrails: { allow: ['Bash(echo *)', 'Read', 'Edit', 'Write', 'ToolSearch', 'Retain'] } }))
  if (seat === 'claude.ai') {
    writeFileSync(join(home, '.mercury', '.mercury.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, theme: 'dark', oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'fixture@example.invalid', organizationUuid: 'fixture-organization' } }))
    writeFileSync(join(home, '.mercury', '.credentials.json'), j({ claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }))
  }
  return {
    home,
    cwd,
    env: {
      HOME: home,
      PATH: arenaPath(nodeBin),
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixtureUrl,
      MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
      ...(seat === 'key' ? { ANTHROPIC_API_KEY: 'fixture-key-000' } : {}),
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_TOOL_SEARCH: 'tst',
      MERCURY_CACHE_DIAGNOSTICS: '1',
      ...extraEnv,
    },
  }
}

function findFile(root: string, match: (path: string) => boolean): string | null {
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, match)
      if (found !== null) return found
    } else if (match(full)) return full
  }
  return null
}

function ttlsOf(body: Body): string[] {
  return [...new Set(markers(body).map(m => m.ttl))]
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
  const { isCacheDiagnosticsRefusal, refuseCacheDiagnostics, cacheDiagnosticsRefusal } = await import('../../src/services/providers/anthropic/cacheDiagnostics.ts')
  const refused = Object.assign(new Error('diagnostics: Extra inputs are not permitted'), { status: 400 })
  check('a 400 that names the diagnostics field is the refusal the retry ladder heals; a 400 about anything else is not; a 500 naming it is not', isCacheDiagnosticsRefusal(refused) && !isCacheDiagnosticsRefusal(Object.assign(new Error('max_tokens too large'), { status: 400 })) && !isCacheDiagnosticsRefusal(Object.assign(new Error('diagnostics'), { status: 500 })))
  refuseCacheDiagnostics('refused in the proof')
  check('after a refusal the process sends the field no more', cacheDiagnosticsRefusal() === 'refused in the proof' && cacheDiagnosticsParam(['msg_01A'], 'main_thread', () => true) === null)
  refuseCacheDiagnostics(null)
  check('the refusal cleared, the field rides again', j(cacheDiagnosticsParam(['msg_01A'], 'main_thread', () => true)) === j({ previous_message_id: 'msg_01A' }))
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

    section('§4 the 1h tier survives a relaunch: a claude.ai seat that held 1h twenty minutes ago resumes on 1h and reads the same prefix; one that held it seventy minutes ago starts cold')
    {
      const SID = 'c0ffee00-0000-4000-8000-00000000c1ea'
      const cached = (turn: ScriptedTurn): ScriptedTurn => ({ ...turn, usage: { input_tokens: 40, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 600 } } as ScriptedTurn)
      const scripted = (): ScriptedTurn[] => [U('Bash', { command: 'echo lease' }), T('S4-T1'), T('S4-T2'), T('S4-T3'), T('S4-T4'), T('S4-T5')].map(cached)
      const fixture = await startFixtureApi([...scripted(), ...Array.from({ length: 6 }, () => handoffTurn())], { bindingCheck: true })
      const arena = makeArena(fixture.url, nodeBin, {}, 'claude.ai')
      arenas.push(arena)
      const args = ['--model', MODEL, '--allowed-tools', 'Bash']
      const first = await runTurns({ node: nodeBin, dist: DIST, args: [...args, '--session-id', SID], cwd: arena.cwd, env: arena.env, timeoutMs: 150_000, turns: ['drive turn 1', 'drive turn 2', 'drive turn 3'] })
      check('§4 the first process answers three turns on the claude.ai seat and exits 0', first.exit === 0 && ['S4-T1', 'S4-T2', 'S4-T3'].every(t => first.stdout.includes(t)), `exit=${first.exit} ${first.stderr.slice(-400)}`)
      const beforeRelaunch = fixture.messageRequests().filter(q => !isHandoffRequest(q))
      check('§4 four main requests, every breakpoint on the 5m tier (the clock starts a headless process on 5m)', beforeRelaunch.length === 4 && beforeRelaunch.every(q => j(ttlsOf(q.body as Body)) === j(['{"type":"ephemeral"}'])), j(beforeRelaunch.map(q => ttlsOf(q.body as Body))))
      const rollupPath = findFile(arena.home, p => p.endsWith(`${SID}.json`) && p.includes('cache-clock'))
      const ledgerPath = findFile(arena.home, p => p.endsWith('prefix-ledger.json') && p.includes(SID))
      check('§4 the first process left its cache-clock rollup and its prefix ledger beside the session', rollupPath !== null && ledgerPath !== null, `rollup=${rollupPath} ledger=${ledgerPath}`)
      if (rollupPath !== null && ledgerPath !== null) {
        const rollup = JSON.parse(readFileSync(rollupPath, 'utf8')) as Record<string, unknown>
        const prefixKey = (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { record: { key: string } }).record.key
        check('§4 the 5m process holds no tier lease', rollup.tier === undefined, j(rollup.tier))
        const lease = (minutesAgo: number): Record<string, unknown> => ({ ...rollup, decidedTtl: '5m', escalatedAtIso: new Date(Date.now() - (minutesAgo + 5) * 60_000).toISOString(), tier: { ttl: '1h', heldAtIso: new Date(Date.now() - minutesAgo * 60_000).toISOString(), sinceIso: new Date(Date.now() - (minutesAgo + 5) * 60_000).toISOString(), prefixKey } })
        const warmLease = lease(20)
        writeFileSync(rollupPath, j(warmLease))
        const warm = await runTurns({ node: nodeBin, dist: DIST, args: [...args, '--resume', SID], cwd: arena.cwd, env: arena.env, timeoutMs: 150_000, turns: ['drive turn 4'] })
        check('§4 the process relaunched twenty minutes into the hour answers and exits 0', warm.exit === 0 && warm.stdout.includes('S4-T4'), `exit=${warm.exit} ${warm.stderr.slice(-400)}`)
        const afterWarm = fixture.messageRequests().filter(q => !isHandoffRequest(q))
        const warmRequest = afterWarm[4]?.body as Body | undefined
        check('§4 its first request sends the 1h tier on both breakpoints: the hour the previous process bought is kept, not re-decided', warmRequest !== undefined && j(ttlsOf(warmRequest)) === j(['{"type":"ephemeral","ttl":"1h"}']), j(warmRequest === undefined ? null : markers(warmRequest)))
        const last = beforeRelaunch[3]!.body as Body
        const verdict = warmRequest === undefined ? null : prefixHeld({ ...last, system: withoutCacheControl(last.system) as Body['system'] }, { ...warmRequest, system: withoutCacheControl(warmRequest.system) as Body['system'] })
        check('§4 it reads the previous process\'s prefix back: system, tools and every shared message byte-identical (the TTL marker aside)', verdict?.held === true, verdict === null ? 'no request' : `${verdict.where}\n      before: ${verdict.before}\n      after:  ${verdict.after}`)
        const refreshed = JSON.parse(readFileSync(rollupPath, 'utf8')) as { tier?: { heldAtIso?: string; prefixKey?: string; sinceIso?: string } }
        check('§4 the relaunched process refreshed the lease with its own request, same prefix, same escalation time', typeof refreshed.tier?.heldAtIso === 'string' && Date.now() - Date.parse(refreshed.tier.heldAtIso) < 10 * 60_000 && refreshed.tier.prefixKey === prefixKey && refreshed.tier.sinceIso === (warmLease.tier as { sinceIso: string }).sinceIso, j(refreshed.tier))
        writeFileSync(rollupPath, j(lease(70)))
        const cold = await runTurns({ node: nodeBin, dist: DIST, args: [...args, '--resume', SID], cwd: arena.cwd, env: arena.env, timeoutMs: 150_000, turns: ['drive turn 5'] })
        check('§4 the process relaunched seventy minutes after the last 1h request answers and exits 0', cold.exit === 0 && cold.stdout.includes('S4-T5'), `exit=${cold.exit} ${cold.stderr.slice(-400)}`)
        const coldRequest = (fixture.messageRequests().filter(q => !isHandoffRequest(q))[5])?.body as Body | undefined
        check('§4 its first request starts cold by the rule: the 5m tier (the hour is spent; a fresh 1h write would buy nothing)', coldRequest !== undefined && j(ttlsOf(coldRequest)) === j(['{"type":"ephemeral"}']), j(coldRequest === undefined ? null : markers(coldRequest)))
      }
      await fixture.close()
    }

    section('§5 the system block is frozen for the session: a compaction mid-turn in a repository whose status moved re-composes it once, on the request that re-writes the context anyway; every later request (the rest of the turn, the next turn) sends the same bytes')
    {
      const SID = 'c0ffee00-0000-4000-8000-00000000f01d'
      const summary: ScriptedTurn = { kind: 'text', text: 'Summary: the operator asked for the note to be read and the repository to be touched; the read is done.', whenBody: 'Produce the summary now.', model: MODEL }
      const turns: ScriptedTurn[] = [
        U('Bash', { command: 'touch changed.txt' }),
        { ...U('Read', { file_path: 'big.txt' }), usage: { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as ScriptedTurn,
        summary,
        U('Bash', { command: 'echo after-the-fold' }),
        T('S5-T1'),
        T('S5-T2'),
      ]
      const fixture = await startFixtureApi([...turns, ...Array.from({ length: 4 }, () => handoffTurn())], { bindingCheck: true })
      const arena = makeArena(fixture.url, nodeBin, { MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '7', MERCURY_COMPACT_KEEP_TAIL: '0' })
      arenas.push(arena)
      writeFileSync(join(arena.home, '.mercury', 'settings.json'), j({ guardrails: { allow: ['Bash(echo *)', 'Bash(touch *)', 'Read'] } }))
      writeFileSync(join(arena.cwd, 'big.txt'), 'the note the model reads before the fold\n')
      const git = (...args: string[]): void => {
        const run = Bun.spawnSync(['git', ...args], { cwd: arena.cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: arena.home, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' } })
        if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`)
      }
      git('init', '-q', '-b', 'main')
      git('add', 'note.txt', 'big.txt')
      git('commit', '-q', '-m', 'the first commit')
      const debugFile = join(arena.home, 'fold.debug.log')
      const failuresBefore = failures
      const r = await runTurns({ node: nodeBin, dist: DIST, args: ['--model', MODEL, '--allowed-tools', 'Bash,Read', '--session-id', SID, '--log-file', debugFile], cwd: arena.cwd, env: arena.env, timeoutMs: 150_000, turns: ['touch the repository, then read the big note', 'and now?'] })
      check('§5 the two turns answer and exit 0', r.exit === 0 && r.stdout.includes('S5-T1') && r.stdout.includes('S5-T2'), `exit=${r.exit} ${r.stderr.slice(-400)}`)
      await fixture.close()
      const all = fixture.messageRequests()
      for (const [i, q] of all.entries()) {
        const body = q.body as Body
        const lastRow = body.messages?.[body.messages.length - 1]
        const lastText = typeof lastRow?.content === 'string' ? lastRow.content : Array.isArray(lastRow?.content) ? (lastRow!.content as Array<{ type?: string; text?: string }>).map(b => b.type === 'text' ? String(b.text ?? '') : `[${b.type}]`).join(' ') : ''
        console.log(`    request ${i + 1}: ${isHandoffRequest(q) ? 'closing ask' : q.raw.includes('Produce the summary now.') ? 'summariser' : 'main'} · ${body.messages?.length ?? 0} messages · system ${(body.system ?? []).map(b => String(b.text ?? '')).join('\n').includes('changed.txt') ? 'names changed.txt' : 'as at boot'} · last: ${j(lastText).slice(0, 90)}`)
      }
      const summariser = all.findIndex(q => q.raw.includes('Produce the summary now.'))
      check('§5 the fold happened inside the first turn: the summariser request came after the big read (whose response declared 150k tokens of context) and before the turn\'s next round', summariser === 2, `summariser at ${summariser}; ${all.length} requests`)
      const requests = all.filter(q => !isHandoffRequest(q) && !q.raw.includes('Produce the summary now.'))
      const bodies = requests.map(q => q.body as Body)
      check('§5 five main requests: two rounds before the fold, the round that carried the summary, the round after it, the next turn', bodies.length === 5, String(bodies.length))
      const systemText = (body: Body | undefined): string => (body?.system ?? []).map(block => String(block.text ?? '')).join('\n')
      const gitLine = (body: Body | undefined): string => systemText(body).split('\n').find(line => line.startsWith('gitStatus:')) ?? ''
      check('§5 the system block carries the repository status (the git status line is in it)', gitLine(bodies[0]) !== '' && systemText(bodies[0]).includes('Current branch: main'), gitLine(bodies[0]).slice(0, 160))
      check('§5 the boot block carries a status git itself read: (clean) before the touch, with the first commit under it', systemText(bodies[0]).includes('Status:\n(clean)') && /Recent commits:\n[0-9a-f]{7,} the first commit/.test(systemText(bodies[0])), systemText(bodies[0]).split('\n').filter(line => /^(Status:|\(|Recent commits:)/.test(line)).join(' | ').slice(0, 200))
      const arenaStatus = Bun.spawnSync(['git', 'status', '--short', '--', '.'], { cwd: arena.cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: arena.home } }).stdout.toString()
      check('§5 the touch changed the repository: git status in the arena names changed.txt as untracked', /^\?\? changed\.txt$/m.test(arenaStatus), j(arenaStatus))
      check('§5 before the fold the system block does not move: the touch changed the repository, the block kept the status as first sent', j(withoutCacheControl(bodies[0]?.system)) === j(withoutCacheControl(bodies[1]?.system)))
      const foldSystem = systemText(bodies[2])
      check('§5 the request that lands the fold carries the re-composed block: the repository status moved with the touch and the block says so there, where the context is re-written anyway', foldSystem !== systemText(bodies[1]) && /changed\.txt/.test(foldSystem), systemText(bodies[2]).split('\n').filter(line => line.includes('changed.txt')).join(' | ').slice(0, 200))
      for (let i = 3; i < bodies.length; i++) {
        const verdict = prefixHeld(bodies[i - 1]!, bodies[i]!)
        check(`§5 #${i}→#${i + 1}: request ${i + 1} starts with the whole serialized prefix of request ${i} (the system block byte-identical, the history appended)`, verdict.held, `${verdict.where}\n      before: ${verdict.before}\n      after:  ${verdict.after}`)
      }
      check('§5 the next turn sends the system block of the fold request byte for byte (the status is not computed again)', j(withoutCacheControl(bodies[4]?.system)) === j(withoutCacheControl(bodies[2]?.system)))
      const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''
      check('§5 the debug log names the re-composition once, at the fold', debug.split('\n').filter(line => line.includes('composed again after the fold')).length === 1)
      check('§5 the product\'s ledger saw no rewrite of sent history in the turn after the fold', !debug.includes('names a rewrite of sent history'), debug.split('\n').filter(l => l.includes('rewrite of sent history')).slice(0, 2).join(' | '))
      const transcript = findFile(arena.home, p => p.endsWith(`${SID}.jsonl`) && p.includes('projects'))
      const rows = transcript === null ? [] : readFileSync(transcript, 'utf8').split('\n')
      const records = rows.filter(line => line.includes('"attachmentType":"bound_prefix"')).map(line => { try { return (JSON.parse(line) as { payload?: { fields?: { systemContext?: Record<string, string> } } }).payload?.fields?.systemContext } catch { return undefined } })
      check('§5 the bound-prefix record written after the fold carries the status the fold request sent, so a later resume replays the same bytes', records.length >= 2 && /changed\.txt/.test(records[records.length - 1]?.gitStatus ?? ''), j(records.map(r => (r?.gitStatus ?? '').slice(0, 80))))
      if (failures !== failuresBefore && existsSync(debugFile)) {
        const kept = join(tmpdir(), 'cache-prefix-stable-fold.debug.log')
        copyFileSync(debugFile, kept)
        console.log(`  (the fold debug log is kept at ${kept})`)
      }
    }

    section('§6 a posture change rides the message stream, never the system block')
    {
      const posture = await import('../../src/utils/cockpit/runtimePosture.ts')
      posture.resetRuntimePostureForTest()
      posture.markSessionNonInteractive('default')
      const atBoot = posture.getRuntimePostureSection()
      const reminder = posture.markSessionPermissionMode('flow')
      check('§6 the posture section is a boot-time value: an operator mode change after boot leaves it byte-identical', posture.getRuntimePostureSection() === atBoot && atBoot !== null && atBoot.includes('Permission mode for this run: default'))
      check('§6 the change travels as a reminder for the next prompt (the notice road), naming the mode at boot and the new one', reminder !== null && reminder.includes('flow') && reminder.includes('from default') && reminder.includes('the Runtime posture section states the mode at boot'), reminder ?? 'null')
      posture.resetRuntimePostureForTest()
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
