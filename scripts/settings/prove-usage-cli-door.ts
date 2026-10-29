#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { usagePlanWorld } from '../providers/lib/usage-plan-world.ts'

const world = await usagePlanWorld()
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
type Window = { key: string; label: string; state: string; usedPct?: number; resetsAt?: string; resetsIn?: string; observedAt?: string; source?: string; freshness: { state: string; ageMs?: number; words?: string } }
type Source = { provider: string; sourceKind: string; label: string; tier?: string; windows: Window[]; pools: Window[]; figures: unknown[]; readerNote?: string; spend: { inputTokens: number; outputTokens: number; costUSD: number; models: number; byModel: unknown[] }; binding?: { windowName: string; window: Window } }
type Reading = { schema: number; readAt: string; line: string; model: string; sampled: string[]; signIns: Array<{ provider: string; credentialed: boolean; label?: string; identity?: string }>; active: Source; providers: Source[] }

try {
  const door = await import(world.path('src/cli/handlers/usage.ts')) as typeof import('../../src/cli/handlers/usage.js')

  section('§1 the JSON reading on a home with two sign-ins (a Kimi sign-in and a GLM Coding Plan key): what the /usage screen reads, with every figure stamped (RED on the base: no usage verb exists — `mercury usage` fell to the docs skill and --json was an unknown option)')
  const requestsBefore = world.requests.length
  const reading = await door.composeUsageReading(world.now()) as unknown as Reading
  check('schema 1, readAt the clock, the engine model the reading resolved against named', reading.schema === 1 && reading.readAt === new Date(world.now()).toISOString() && typeof reading.model === 'string' && reading.model.length > 0, JSON.stringify({ schema: reading.schema, readAt: reading.readAt, model: reading.model }))
  check('the sign-ins are the credential presences the screen plans its sections from: moonshot and zai credentialed with their labels, the rest not', reading.signIns.filter(f => f.credentialed).map(f => f.provider).sort().join(',') === 'moonshot,zai' && reading.signIns.some(f => f.provider === 'zai' && f.label === 'GLM Coding Plan key') && reading.signIns.some(f => f.provider === 'anthropic' && !f.credentialed), JSON.stringify(reading.signIns))
  check('the two credentialed families were sampled through the screen\'s open door, and a sample inside the floor made no new request (the last observation serves)', reading.sampled.sort().join(',') === 'moonshot,zai' && world.requests.length === requestsBefore, `${JSON.stringify(reading.sampled)} requests ${requestsBefore} → ${world.requests.length}`)
  const kimi = reading.providers.find(p => p.provider === 'moonshot')
  const glm = reading.providers.find(p => p.provider === 'zai')
  check('the Kimi sign-in: its two windows with used % and reset time, as the fixture stated them (5h 50%, week 25%)', kimi !== undefined && kimi.windows.length === 2 && kimi.windows.some(w => w.usedPct === 50 && w.resetsAt === new Date(world.resetAtMs).toISOString()) && kimi.windows.some(w => w.usedPct === 25), JSON.stringify(kimi?.windows))
  check('the GLM Coding Plan key: its two windows (5h 17%, week 3%) with their reset times', glm !== undefined && glm.windows.length === 2 && glm.windows.some(w => w.usedPct === 17 && w.resetsAt === new Date(world.glmFiveHourResetAtMs).toISOString()) && glm.windows.some(w => w.usedPct === 3 && w.resetsAt === new Date(world.glmWeekResetAtMs).toISOString()), JSON.stringify(glm?.windows))
  const every = [...(kimi?.windows ?? []), ...(glm?.windows ?? [])]
  check('every window carries its source and its age — the stale stamp\'s facts: endpoint-fed, observed 12 s ago, live', every.length === 4 && every.every(w => w.source === 'endpoint' && w.observedAt === new Date(world.observedAtMs).toISOString() && w.freshness.state === 'live' && w.freshness.ageMs === 12_000 && w.freshness.words === 'endpoint-fed · read 12 s ago'), JSON.stringify(every.map(w => w.freshness)))
  check('every window carries the reset words the screen paints', every.every(w => typeof w.resetsIn === 'string' && w.resetsIn.startsWith('resets ')), JSON.stringify(every.map(w => w.resetsIn)))
  check('the active source is the session model\'s family (GLM) with its binding window named', reading.active.provider === 'zai' && reading.active.binding !== undefined && reading.active.binding.window.usedPct === 17, JSON.stringify({ provider: reading.active.provider, binding: reading.active.binding }))
  check('the session spend rides each family as the screen reads it: no turn ran here, so 0 tokens and no model rows — never an invented figure', reading.providers.every(p => p.spend.inputTokens === 0 && p.spend.outputTokens === 0 && p.spend.models === 0 && p.spend.byModel.length === 0), JSON.stringify(reading.providers.map(p => p.spend)))
  check('the compact figures line is the /usage popup\'s own line (the family, the sign-ins, the live meters)', reading.line.includes('session on') && reading.line.includes('signed in') && /session 17%/.test(reading.line) && /week 3%/.test(reading.line), reading.line)
  check('no fixture request escaped loopback', world.escaped.length === 0, JSON.stringify(world.escaped))

  section('§2 one sign-in reporting, one not: past the floor the Kimi endpoint refuses — the JSON carries its cached reading with its age and the reader\'s own note, never a fetched figure it did not get; the GLM read is fresh')
  world.refuse(true)
  world.setNow(world.observedAtMs + 3 * world.fresh.usagePollTtlMs())
  const requestsMid = world.requests.length
  const second = await door.composeUsageReading(world.now()) as unknown as Reading
  const kimi2 = second.providers.find(p => p.provider === 'moonshot')
  const glm2 = second.providers.find(p => p.provider === 'zai')
  check('exactly one read per plan was asked (the screen\'s open sample, nothing more)', world.requests.length === requestsMid + 2 && world.requests.slice(requestsMid).filter(r => r === 'GET /coding/v1/usages').length === 1 && world.requests.slice(requestsMid).filter(r => r === 'GET /api/monitor/usage/quota/limit').length === 1, JSON.stringify(world.requests.slice(requestsMid)))
  check('the refused Kimi read: the cached figures still stand (50% · 25%) and read STALE with their age', kimi2 !== undefined && kimi2.windows.length === 2 && kimi2.windows.every(w => w.freshness.state === 'stale' && typeof w.freshness.words === 'string' && w.freshness.words.includes('stale · last read')) && kimi2.windows.some(w => w.usedPct === 50), JSON.stringify(kimi2?.windows))
  check('…and the reader says so in its own words beside them', kimi2 !== undefined && typeof kimi2.readerNote === 'string' && /503|failed|refused/.test(kimi2.readerNote), kimi2?.readerNote ?? '(no note)')
  check('the GLM read is live again (read 0 s ago) with the same figures', glm2 !== undefined && glm2.windows.every(w => w.freshness.state === 'live' && w.freshness.ageMs === 0) && glm2.windows.some(w => w.usedPct === 17), JSON.stringify(glm2?.windows))
  check('no fixture request escaped loopback', world.escaped.length === 0, JSON.stringify(world.escaped))
  world.refuse(false)

  section('§3 the built product: `mercury usage` prints the compact line, `mercury usage --json` the reading, exit 0, nothing but the two plan endpoints asked')
  const DIST = join(world.root, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    console.log('  [SKIP — LOUD] dist/mercury.mjs missing — run `bun run build.ts` first; §1–§2 above are the in-process evidence')
  } else {
    const env = { ...process.env, MERCURY_DAEMON_DIR: join(process.env.MERCURY_CONFIG_DIR ?? '', 'daemon'), TERM: 'dumb' }
    const run = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise(resolve => {
        const child = spawn('node', [DIST, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.stderr.on('data', chunk => { stderr += String(chunk) })
        const guard = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', status => {
          clearTimeout(guard)
          resolve({ status, stdout, stderr })
        })
      })
    const requestsBeforeChild = world.requests.length
    const json = await run(['usage', '--json'])
    let parsed: Reading | null = null
    try {
      parsed = JSON.parse(json.stdout) as Reading
    } catch {
      parsed = null
    }
    check('`mercury usage --json` exits 0 with one JSON document on stdout', json.status === 0 && parsed !== null && parsed.schema === 1, `${json.status} · ${json.stdout.slice(0, 200)} · ${json.stderr.slice(0, 200)}`)
    check('the document names both sign-ins and the GLM windows with their used %', parsed !== null && parsed.signIns.some(e => e.provider === 'moonshot') && parsed.signIns.some(e => e.provider === 'zai') && (parsed.providers.find(p => p.provider === 'zai')?.windows.some(w => w.usedPct === 17) ?? false), JSON.stringify(parsed?.providers.map(p => ({ provider: p.provider, windows: p.windows.map(w => w.usedPct) }))))
    check('the child asked the two plan endpoints once each and nothing else reached the fixture', world.requests.slice(requestsBeforeChild).filter(r => r === 'GET /coding/v1/usages').length === 1 && world.requests.slice(requestsBeforeChild).filter(r => r === 'GET /api/monitor/usage/quota/limit').length === 1 && world.requests.length === requestsBeforeChild + 2, JSON.stringify(world.requests.slice(requestsBeforeChild)))
    const text = await run(['usage'])
    const lines = text.stdout.split('\n').filter(l => l.trim() !== '')
    check('`mercury usage` prints the one compact figures line and exits 0', text.status === 0 && lines.length === 1 && lines[0]!.includes('signed in') && /\d+%/.test(lines[0]!), `${text.status} · ${text.stdout.slice(0, 200)} · ${text.stderr.slice(0, 200)}`)
    check('the plain line is not the docs skill\'s prose and --json is not an unknown option', !text.stdout.includes('/usage shows') && !json.stderr.includes('unknown option'), `${text.stdout.slice(0, 120)} · ${json.stderr.slice(0, 120)}`)
  }
} finally {
  world.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'usage-cli-door: ALL LAWS HOLD' : `usage-cli-door: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
