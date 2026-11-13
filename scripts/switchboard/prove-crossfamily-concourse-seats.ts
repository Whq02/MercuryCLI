#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'cma-seats-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const workPlain = join(SCRATCH, 'work-plain')
const workGpt = join(SCRATCH, 'work-gpt')
const workHaiku = join(SCRATCH, 'work-haiku')
const workRouted = join(SCRATCH, 'work-routed')
for (const d of [home, daemonDir, work, workPlain, workGpt, workHaiku, workRouted]) mkdirSync(d, { recursive: true })

delete process.env.NODE_ENV
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'GOOGLE_API_KEY']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'
process.env.MERCURY_CACHE_CLOCK = '0'
process.chdir(work)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const REPO = join(new URL('.', import.meta.url).pathname, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — crossfamily concourse seats prover exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

const { startCrossfamilyFixture, CMA_STEER_TEXT } = await import('../lib/crossfamilyConcourseFixture.ts')
const text = (v: unknown): string => JSON.stringify(v) ?? ''
const GPT_ID = 'gpt-5.5'
const HAIKU_ID = 'claude-haiku-4-5-20251001'
const ROUTED_ID = 'openrouter/nvidia/nemotron-nano-9b-v2:free'
const fixture = await startCrossfamilyFixture({ port: 25137, seatStyle: 'instant', gptId: GPT_ID, nemotronId: ROUTED_ID })
const captured = fixture.captured
Object.assign(process.env, fixture.env)

console.log('============================================================')
console.log(' crossfamily concourse seats — a session born at the daemon door runs on the family its model names')
console.log('============================================================')

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work, workPlain, workGpt, workHaiku, workRouted])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_PARTY: '0',
    MERCURY_TERMINAL_TITLE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})

const untilAsync = async (pred: () => Promise<boolean>, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { executeBoardControl } = await import('../../src/services/concourse/boardControl.ts')
const q = await import('../../src/services/providers/openai/qualificationStore.ts')

check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' } as never)).ok === true, 60_000))

const seatJsonl = (sid: string, dir: string): string => join(paths.getProjectDir(dir), `${sid}.jsonl`)
const landed = (sid: string, dir: string, words: string): Promise<boolean> =>
  untilAsync(async () => existsSync(seatJsonl(sid, dir)) && readFileSync(seatJsonl(sid, dir), 'utf8').includes(words), 45_000)
type Birth = { ok?: boolean; sessionId?: string; modelId?: string; error?: string }
const dispatch = async (tag: string, prompt: string, workspaceDir: string, title: string, model?: string): Promise<Birth> =>
  (await daemonControlRpc(
    { op: 'concourseDispatch', clientMessageId: `cma-seat-${tag}`, prompt, workspaceDir, title, ...(model !== undefined ? { model } : {}) } as never,
    { timeoutMs: 15_000 },
  )) as Birth
const freeSeat = async (sid: string): Promise<void> => {
  const listed = (await daemonControlRpc({ op: 'concourseList' } as never)) as { workers?: Array<Record<string, unknown>> }
  for (const w of listed.workers ?? []) {
    if (String(w.sessionId ?? '') !== sid) continue
    try {
      await daemonControlRpc({ op: 'concourseControl', action: 'stop', sessionId: sid, by: 'operator' } as never)
    } catch {
    }
    try {
      await daemonControlRpc({ op: 'concourseRelease', workerId: String(w.workerId ?? '') } as never)
    } catch {
    }
  }
}

let plainSid = ''
section('§1 no model named — the seat lands on the operator default, on the Anthropic wire')
{
  const before = captured.length
  const born = await dispatch('plain', 'seat-task-plain: work the plain brief', workPlain, 'CMA Plain')
  check('the dispatch is admitted at the daemon door', born.ok === true && /^[0-9a-f-]{36}$/.test(String(born.sessionId ?? '')), text(born))
  plainSid = String(born.sessionId ?? '')
  check('the door names the model it resolved, an Anthropic id', declaredRouteOf(String(born.modelId ?? '')) === 'anthropic', String(born.modelId))
  check('the seat streams its turn (its transcript lands)', await landed(plainSid, workPlain, 'plain-landed body.'), plainSid)
  const hits = captured.slice(before).filter(h => h.lane !== 'other')
  check('every call of the turn rode /v1/messages with the id the door named', hits.length >= 1 && hits.every(h => h.lane === 'anthropic-seat' && h.path.endsWith('/v1/messages') && h.model === born.modelId), hits.map(h => `${h.lane}:${h.model}`).join(','))
}

section('§2 a steer from the board reaches that seat and is answered on its own wire')
{
  const before = captured.length
  const receipt = await executeBoardControl({ verb: 'session.redirect', sessionId: plainSid, clientMessageId: 'cma-seat-steer', instruction: CMA_STEER_TEXT, by: 'operator' })
  check("the board's message is applied", receipt.outcome === 'applied', text(receipt))
  check('the words land in the seat transcript and the seat answers them', await landed(plainSid, workPlain, 'steer-landed body.') && readFileSync(seatJsonl(plainSid, workPlain), 'utf8').includes(CMA_STEER_TEXT), plainSid)
  const hits = captured.slice(before).filter(h => h.lane !== 'other')
  check('the answer rode the same Anthropic wire', hits.length >= 1 && hits.every(h => h.lane === 'anthropic-seat'), hits.map(h => `${h.lane}:${h.model}`).join(','))
  await freeSeat(plainSid)
}

section('§3 a GPT id — the seat runs on the Responses endpoint with the exact id')
{
  const before = captured.length
  const born = await dispatch('gpt', 'seat-task-gpt: work on the gpt engine', workGpt, 'CMA Gpt Seat', GPT_ID)
  check('a gpt dispatch is admitted at the daemon door', born.ok === true, text(born))
  check('the door names the model it was asked for (never a silent substitute)', born.modelId === GPT_ID, String(born.modelId))
  const sid = String(born.sessionId ?? '')
  check('the seat streams whole on its own dialect (its transcript lands)', await landed(sid, workGpt, 'gpt-landed body.'), sid)
  const hits = captured.slice(before).filter(h => h.lane !== 'other')
  check('every call rode the Responses endpoint with the exact id', hits.length >= 1 && hits.every(h => h.lane === 'openai-seat' && h.path === '/openai/v1/responses' && h.model === GPT_ID), hits.map(h => `${h.lane}:${h.path}:${h.model}`).join(','))
  await freeSeat(sid)
}

section('§4 a small Anthropic id — the seat carries it on its own family wire')
{
  const before = captured.length
  const born = await dispatch('haiku', 'seat-task-haiku: work the economy brief', workHaiku, 'CMA Haiku Seat', HAIKU_ID)
  check('the haiku dispatch is admitted', born.ok === true, text(born))
  const sid = String(born.sessionId ?? '')
  check('the seat streams on the Anthropic wire (its transcript lands)', await landed(sid, workHaiku, 'haiku-landed body.'), sid)
  const hits = captured.slice(before).filter(h => h.lane !== 'other')
  check('the seat call carried the haiku id', hits.length >= 1 && hits.every(h => h.lane === 'anthropic-seat' && /haiku/i.test(h.model)), hits.map(h => `${h.lane}:${h.model}`).join(','))
  await freeSeat(sid)
}

section('§5 a routed id — the seat rides the OpenRouter wire')
{
  const before = captured.length
  const born = await dispatch('routed', 'seat-task-nemotron: work the routed brief', workRouted, 'CMA Nemotron Seat', ROUTED_ID)
  check('the routed dispatch is admitted', born.ok === true, text(born))
  const sid = String(born.sessionId ?? '')
  check('the seat streams on the OpenRouter wire (its transcript lands)', await landed(sid, workRouted, 'nemotron-landed body.'), sid)
  const hits = captured.slice(before).filter(h => h.lane !== 'other')
  check('the seat call rode the OpenRouter wire with the nemotron id', hits.length >= 1 && hits.every(h => h.lane === 'openrouter-seat' && /nemotron/i.test(h.model)), hits.map(h => `${h.lane}:${h.model}`).join(','))
  await freeSeat(sid)
}

section('§6 the wire-separation law over the whole run')
{
  const anthropicSeats = captured.filter(h => h.lane === 'anthropic-seat')
  check('every Anthropic seat call in the run rode /v1/messages', anthropicSeats.length >= 3 && anthropicSeats.every(h => h.path.endsWith('/v1/messages')), String(anthropicSeats.length))
  const gptSeats = captured.filter(h => h.lane === 'openai-seat')
  check('every GPT seat call rode its own Responses endpoint', gptSeats.length >= 1 && gptSeats.every(h => h.path === '/openai/v1/responses'), String(gptSeats.length))
  const routedSeats = captured.filter(h => h.lane === 'openrouter-seat')
  const openrouterEndpointOf = (h: { body: unknown }): string =>
    Array.isArray((h.body as { tools?: unknown }).tools) && ((h.body as { tools: Array<{ type?: string }> }).tools).some(t => t?.type === 'openrouter:tool_search')
      ? '/openrouter/api/v1/responses'
      : '/openrouter/api/v1/chat/completions'
  check('every routed seat call rode the OpenRouter wire — the Responses endpoint when the seat defers (its search tool first), the chat endpoint when it does not',
    routedSeats.length >= 1 && routedSeats.every(h => h.path === openrouterEndpointOf(h)),
    routedSeats.map(h => `${h.path}${openrouterEndpointOf(h) === h.path ? '' : ' (expected ' + openrouterEndpointOf(h) + ')'}`).join(','))
  check('no call of the run rode a wire no seat was asked for', captured.filter(h => h.lane === 'zai-seat').length === 0, captured.filter(h => h.lane === 'zai-seat').map(h => h.model).join(','))
  check('only the GPT family minted qualification receipts, and none in a chair\'s name',
    q.readQualificationReceipts().every(r => declaredRouteOf(r.receipt.modelId) === 'openai' && String(r.receipt.role) !== 'coordinator'),
    text(q.readQualificationReceipts().map(r => [r.receipt.modelId, r.receipt.role])))
  const unknown = captured.filter(h => h.lane === 'other' && !h.path.startsWith('GET'))
  check('no un-modelled POST reached the fixture', unknown.length === 0, unknown.map(h => h.path).join(','))
}

try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
}
daemon.kill('SIGTERM')
await fixture.close()
if (process.env.CMA_KEEP === '1') console.log(`[keep] ${SCRATCH}`)
else removeScratch(SCRATCH)

console.log(failures === 0 ? `\nprove-crossfamily-concourse-seats: ALL LAWS HOLD (${checks} checks)` : `\nprove-crossfamily-concourse-seats: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
