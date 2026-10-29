#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const scratch = mkdtempSync(join(tmpdir(), 'warns-clear-'))
const HOME = join(scratch, '.mercury')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const core = await import('../../src/utils/healthCertCore.ts')
const refusal = await import('../../src/services/providers/anthropic/modelRefusal.ts')
const thinking = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
const { describeAnthropicClientContract } = await import('../../src/constants/oauth.ts')

const HOUR = 60 * 60 * 1000
const NOW = Date.now()

section('§1 a refused model id is a notice, not a permanent caution')
{
  const status = (refusal as { modelRefusalHealthStatus?: (r: { kind: string; seenAtMs: number }, now: number) => string }).modelRefusalHealthStatus
  check('the store exports the notice law', typeof status === 'function')
  check('a not-served refusal seen ten minutes ago still warns', status?.({ kind: 'not-served', seenAtMs: NOW - 10 * 60_000 }, NOW) === 'warn')
  check('a not-served refusal seen two hours ago is a record (info)', status?.({ kind: 'not-served', seenAtMs: NOW - 2 * HOUR }, NOW) === 'info')
  check('a client-version floor refusal keeps warning until the client moves', status?.({ kind: 'contract-floor', seenAtMs: NOW - 2 * HOUR }, NOW) === 'warn')
  check('a subscription-tier refusal keeps warning until the plan moves', status?.({ kind: 'tier', seenAtMs: NOW - 2 * HOUR }, NOW) === 'warn')
}

section('§2 a recorded thinking drop is a notice, not a permanent caution')
{
  const ledger = (at: number, sessionId: string) => ({
    last: { at: new Date(at).toISOString(), kind: 'first' as const, lawful: null, reason: 'prefix_binding_mismatch', path: 'messages.61.content.0', count: 6, consecutive: 1, model: 'claude-sonnet-5-5', part: "the system prompt's Memory section" },
    longestRun: 1,
    session: { id: sessionId, drops: 1, notice: null },
  })
  const health = thinking.preservedThinkingHealth as (l: unknown, s: string, now?: number) => { status: string; detail?: string; fix?: string }
  const recent = health(ledger(NOW - 10 * 60_000, 'other-session'), 'this-session', NOW)
  check('a rewrite recorded ten minutes ago warns, with the bug-report fix', recent.status === 'warn' && (recent.fix ?? '').includes('bug report'), JSON.stringify(recent))
  const old = health(ledger(NOW - 2 * HOUR, 'other-session'), 'this-session', NOW)
  check('the same record two hours later, from another session, is info', old.status === 'info', JSON.stringify(old))
  check('…saying so', (old.detail ?? '').includes('informational only'), JSON.stringify(old))
  check('…while the bug-report fix still stands for the report', (old.fix ?? '').includes('bug report'))
  const mine = health(ledger(NOW - 2 * HOUR, 'this-session'), 'this-session', NOW)
  check('a record from THIS session keeps warning whatever its age (the drops are happening here)', mine.status === 'warn', JSON.stringify(mine))
}

section('§3 the rail keeps a deep fault behind a later fast caution (the carry law, pure)')
{
  const carry = (core as { carryDeepReadings?: (f: unknown, p: unknown, ids: Set<string>) => { verdict: string; attention: Array<{ id: string; status: string; ranAt?: string; depth?: string }>; counts: Record<string, number> } }).carryDeepReadings
  check('the core exports the carry law', typeof carry === 'function')
  const deepAt = new Date(NOW - 20_000).toISOString()
  const previous = {
    verdict: 'fault', ranAt: deepAt, head: { sha: null, branch: null, dirty: null }, version: 'x', depth: 'deep',
    counts: { ok: 1, warn: 1, fail: 1, stale: 0, unknown: 0, off: 0, info: 0 },
    attention: [
      { id: 'artifact-signature-payload', label: 'Payload signature', status: 'fail', evidence: 'TAMPERED — payload tree differs', depth: 'deep' },
      { id: 'model-refusals', label: 'Refused models', status: 'warn', evidence: 'claude-banana-9', depth: 'fast' },
    ],
  }
  const fresh = {
    verdict: 'caution', ranAt: new Date(NOW).toISOString(), head: { sha: null, branch: null, dirty: null }, version: 'x', depth: 'fast',
    counts: { ok: 2, warn: 1, fail: 0, stale: 0, unknown: 0, off: 0, info: 0 },
    attention: [{ id: 'model-refusals', label: 'Refused models', status: 'warn', evidence: 'claude-banana-9', depth: 'fast' }],
  }
  const merged = carry?.(fresh, previous, new Set(['model-refusals', 'build-identity']))
  check('a fast caution after a deep fault keeps the fault', merged?.verdict === 'fault', JSON.stringify(merged))
  const carried = merged?.attention.find(r => r.id === 'artifact-signature-payload')
  check('the deep row rides along with its own stamp and depth', carried?.status === 'fail' && carried.ranAt === deepAt && carried.depth === 'deep', JSON.stringify(merged?.attention))
  check('the fast row is the fresh one, once', merged?.attention.filter(r => r.id === 'model-refusals').length === 1 && merged?.counts.fail === 1, JSON.stringify(merged))
  const deepAgain = carry?.({ ...fresh, depth: 'deep', verdict: 'certified', attention: [] }, previous, new Set(['artifact-signature-payload']))
  check('a new deep run supersedes the carried reading', deepAgain?.verdict === 'certified' && deepAgain.attention.length === 0, JSON.stringify(deepAgain))
  const reevaluated = carry?.(fresh, previous, new Set(['model-refusals', 'artifact-signature-payload']))
  check('a row the fresh run re-evaluated is never carried', reevaluated?.verdict === 'caution', JSON.stringify(reevaluated))
  check('with nothing to carry the fresh summary stands as written', carry?.(fresh, null, new Set()) === fresh)
}

function run(args: string[]): { status: number; json: Record<string, unknown> | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MERCURY_CONFIG_DIR: HOME,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-anthropic-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: '/usr/bin/true',
  }
  let stdout = ''
  let stderr = ''
  let status = 0
  try {
    stdout = execFileSync('node', [BIN, ...args], { cwd: scratch, env, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    status = err.status ?? -1
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status, json, stdout, stderr }
}
type Row = { id: string; status: string; evidence?: string; fix?: string; detail?: string; remedy?: { plan?: string; class?: string } }
const rowsOf = (json: Record<string, unknown> | null): Row[] => ((json?.sections ?? []) as Array<{ checks?: Row[] }>).flatMap(s => s.checks ?? [])
function findLastCert(): string | null {
  const root = HOME
  if (!existsSync(root)) return null
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) stack.push(full)
      else if (name === 'last-cert.json') return full
    }
  }
  return null
}

section('§4 live: recent records warn and health --fix forgets them; two-hour-old records are info')
{
  const presented = describeAnthropicClientContract().presented
  const seedRefusal = (seenAtMs: number): void =>
    refusal.noteModelRefusal({ id: 'claude-banana-9', door: 'Claude subscription (max)', kind: 'not-served', words: 'claude-banana-9 is not served on Claude subscription (max) (the endpoint answered 404) — pick a listed model with /model.', seenAtMs, presented } as never, HOME)
  const seedThinking = (at: number): void =>
    writeFileSync(join(HOME, 'preserved-thinking.json'), JSON.stringify({
      last: { at: new Date(at).toISOString(), kind: 'first', lawful: null, reason: 'prefix_binding_mismatch', path: 'messages.61.content.0', count: 6, consecutive: 1, model: 'claude-sonnet-5-5', part: "the system prompt's Memory section" },
      longestRun: 1,
      session: { id: 'c6f8e7a1-0000-4000-8000-000000000000', drops: 5, notice: null },
    }, null, 2))
  seedRefusal(NOW - 10 * 60_000)
  seedThinking(NOW - 10 * 60_000)
  check('the records were seeded', readdirSync(join(HOME, 'model-refusals')).some(n => n.endsWith('.json')) && existsSync(join(HOME, 'preserved-thinking.json')))
  const recent = run(['health', '--json'])
  const refusalsRow = rowsOf(recent.json).find(r => r.id === 'model-refusals')
  const thinkingRow = rowsOf(recent.json).find(r => r.id === 'preserved-thinking')
  check('health --json answered', recent.json !== null, recent.stderr.slice(-300))
  check('a ten-minute-old refusal warns and carries a safe forget remedy', refusalsRow?.status === 'warn' && refusalsRow.remedy?.class === 'safe' && (refusalsRow.remedy.plan ?? '').includes('forget'), JSON.stringify(refusalsRow))
  check('a ten-minute-old thinking record warns and carries a safe forget remedy', thinkingRow?.status === 'warn' && thinkingRow.remedy?.class === 'safe' && (thinkingRow.remedy.plan ?? '').includes('forget'), JSON.stringify(thinkingRow))

  const fixRefusals = run(['health', '--fix', '--only', 'model-refusals'])
  const applied = (fixRefusals.json?.fixes ?? []) as Array<{ id: string; verified?: { ok: boolean } }>
  check('health --fix --only model-refusals applies a remedy and verifies it', fixRefusals.status === 0 && applied.some(f => f.id === 'model-refusals' && f.verified?.ok === true), `${fixRefusals.status} ${fixRefusals.stdout.slice(0, 400)} ${fixRefusals.stderr.slice(-200)}`)
  check('…and the records are gone', !existsSync(join(HOME, 'model-refusals')) || readdirSync(join(HOME, 'model-refusals')).every(n => !n.endsWith('.json')))
  const fixThinking = run(['health', '--fix', '--only', 'preserved-thinking'])
  const appliedThinking = (fixThinking.json?.fixes ?? []) as Array<{ id: string; verified?: { ok: boolean } }>
  check('health --fix --only preserved-thinking applies a remedy and verifies it', fixThinking.status === 0 && appliedThinking.some(f => f.id === 'preserved-thinking' && f.verified?.ok === true), `${fixThinking.status} ${fixThinking.stdout.slice(0, 400)} ${fixThinking.stderr.slice(-200)}`)
  check('…and the record is gone', !existsSync(join(HOME, 'preserved-thinking.json')))
  const after = run(['health', '--json'])
  check('afterwards the thinking row reads ok and the refusals row reads no refusal', rowsOf(after.json).find(r => r.id === 'preserved-thinking')?.status === 'ok' && rowsOf(after.json).find(r => r.id === 'model-refusals')?.status === 'info', JSON.stringify([rowsOf(after.json).find(r => r.id === 'preserved-thinking'), rowsOf(after.json).find(r => r.id === 'model-refusals')]))

  seedRefusal(NOW - 2 * HOUR)
  seedThinking(NOW - 2 * HOUR)
  const old = run(['health', '--json'])
  const oldRefusals = rowsOf(old.json).find(r => r.id === 'model-refusals')
  const oldThinking = rowsOf(old.json).find(r => r.id === 'preserved-thinking')
  check('a two-hour-old refusal reads info and still lists the id', oldRefusals?.status === 'info' && (oldRefusals.evidence ?? '').includes('claude-banana-9'), JSON.stringify(oldRefusals))
  check('a two-hour-old thinking record from another session reads info', oldThinking?.status === 'info', JSON.stringify(oldThinking))
  check('neither old record holds the certificate at caution', !['warn', 'fail'].includes(oldRefusals?.status ?? '') && !['warn', 'fail'].includes(oldThinking?.status ?? ''))
}

section('§5 live: a fast certificate written after a deep fault keeps the fault in the rail\'s summary')
{
  const path = findLastCert()
  check('the certificate summary file exists after the runs above', path !== null, HOME)
  if (path !== null) {
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const deepAt = new Date(NOW - 5_000).toISOString()
    writeFileSync(path, JSON.stringify({
      ...current,
      _v: 1,
      verdict: 'fault',
      ranAt: deepAt,
      depth: 'deep',
      counts: { ...(current.counts as Record<string, number>), fail: 1 },
      attention: [{ id: 'artifact-signature-payload', label: 'Payload signature', status: 'fail', evidence: 'TAMPERED — payload tree differs from the signed digest', depth: 'deep' }],
    }, null, 2))
    const fast = run(['health', '--json'])
    check('the fast run itself is not a fault (nothing fast fails here)', String(fast.json?.verdict ?? '') !== 'fault', String(fast.json?.verdict))
    const written = JSON.parse(readFileSync(path, 'utf8')) as { verdict: string; depth?: string; attention: Array<{ id: string; status: string; depth?: string; ranAt?: string }> }
    check('the summary the rail reads still says fault', written.verdict === 'fault', JSON.stringify({ verdict: written.verdict, depth: written.depth }))
    const carried = written.attention.find(r => r.id === 'artifact-signature-payload')
    check('…carrying the deep row with the deep run\'s own stamp', carried?.status === 'fail' && carried.depth === 'deep' && carried.ranAt === deepAt, JSON.stringify(written.attention))
    check('…under the fast run\'s own depth and time', written.depth === 'fast', JSON.stringify({ depth: written.depth }))
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-warns-clear-and-the-rail-keeps-the-fault — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-warns-clear-and-the-rail-keeps-the-fault — all checks pass')
process.exit(0)
