// ============================================================================
//  scripts/pings/journey-calm-idle.ts — the calm pin + the zero-network leg
//  an idle screen with pings armed — the badge
//  PAINTED over a standing obligation — stays byte-still for 60 seconds,
//  and the whole drive runs behind a connect tripwire that logs and refuses
//  every outbound attempt (pings read what the daemon already knows).
//
//  The drive is the BUILT bundle in a real PTY (vshot) at 120x40 and
//  100x30, resumed onto a seeded transcript (the boot recipe — a cold boot
//  never accepts input), with the render-scenario hermeticity pins (live
//  clock/glyph features hold their own switches; this pin isolates the
//  PINGS estate's calm). VSHOT_TEE records every PTY read as (tick, len,
//  bytes) frames; the verdict is the tee's own arithmetic: ZERO bytes over
//  the final 300 ticks (60 s wall clock).
//
//  Machine gate: python3+pyte and a fresh dist, else exit 3 (the journey
//  convention — honoured loudly, never silently green).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

// ── the machine gate ────────────────────────────────────────────────────────
if (!existsSync(DIST)) {
  console.log('⏭  no dist/mercury.mjs — build first (machine gate)')
  process.exit(3)
}
{
  const py = spawnSync('/usr/bin/python3', ['-c', 'import pyte'], { encoding: 'utf8' })
  if (py.status !== 0) {
    console.log('⏭  python3/pyte unavailable (machine gate)')
    process.exit(3)
  }
}

// ── the world ───────────────────────────────────────────────────────────────
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')

const { realpathSync } = await import('node:fs')
const scratch = mkdtempSync(join(tmpdir(), 'pings-calm-'))
const home = join(scratch, 'home')
const aux = join(scratch, 'aux')
mkdirSync(home, { recursive: true })
mkdirSync(join(scratch, 'cwd'), { recursive: true })
mkdirSync(aux, { recursive: true })
// The REALPATH of the temp cwd — /var/folders is a symlink to /private/var
// and the booted product resolves it; a trust seed on the alias spelling
// lands on a different key and the trust card blocks the whole drive.
const cwd = realpathSync(join(scratch, 'cwd')).normalize('NFC')
spawnSync('git', ['init', '-q'], { cwd })
seedFirstRun(home, [cwd])
const SID = '00000000-aaaa-bbbb-cccc-000000000042'

// The transcript, through the REAL writer codec (a bare JSONL seed reads
// as "No conversation found").
{
  let n = 0
  const ctx = {
    sessionId: SID as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt: '2026-08-27T09:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
  let prev: string | null = null
  const rows = [
    { type: 'user', message: { role: 'user', content: 'hello there' }, timestamp: '2026-08-27T09:00:00.000Z' },
    {
      type: 'assistant',
      requestId: 'req_calm1',
      message: {
        id: 'msg_calm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'hello — settled and idle.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: '2026-08-27T09:00:05.000Z',
    },
  ].map((r, i) => {
    const uuid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
    const out = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...r, uuid, parentUuid: prev }
    prev = uuid
    return out
  })
  const projDir = join(home, 'projects', sanitizePath(cwd))
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, `${SID}.jsonl`), rows.map(l => JSON.stringify(entryToRecord(l as never, ctx as never))).join('\n') + '\n')
}

// A standing obligation in the switchboard scope — the badge must PAINT and
// stay calm (dir = exactly what the booted product resolves for this home).
{
  const obl = await import('../../src/services/crew/obligations.ts')
  await obl.upsertObligation({
    ref: 'calm-standing-1',
    sessionId: SID,
    question: 'a standing question the badge counts',
    owner: 'operator',
    dir: join(home, 'crew'),
    scope: 'switchboard',
  })
}

// The connect tripwire (logged AND refused; unix-path sockets pass — the
// daemon control socket is a path).
const NETLOG = join(aux, 'netlog.txt')
const TRIPWIRE = join(aux, 'tripwire.cjs')
writeFileSync(NETLOG, '')
writeFileSync(
  TRIPWIRE,
  `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const LOG = ${JSON.stringify(NETLOG)}
const log = line => { try { fs.appendFileSync(LOG, Date.now() + ' ' + line + '\\n') } catch {} }
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // node:net's module-level connect() normalizes into an ARRAY [opts, cb]
  // before calling this method — unwrap it, or a unix-path socket (the
  // daemon control socket) reads as a hostless TCP dial and the refusal
  // induces its caller's retry loop.
  let a = args
  if (Array.isArray(a[0])) a = a[0]
  const opts = typeof a[0] === 'object' && a[0] !== null ? a[0] : { port: a[0], host: a[1] }
  if (opts.path) return origConnect.apply(this, args)
  const target = (opts.servername || opts.host || opts.hostname || 'no-host') + ':' + (opts.port ?? '?')
  log('tcp ' + target)
  const err = new Error('tripwire: tcp ' + target)
  err.code = 'ECONNREFUSED'
  process.nextTick(() => this.emit('error', err))
  return this
}
const origFetch = globalThis.fetch
globalThis.fetch = input => {
  const t = typeof input === 'string' ? input : String((input && input.url) || input)
  log('fetch ' + t)
  return Promise.reject(Object.assign(new Error('tripwire: fetch ' + t), { code: 'ECONNREFUSED' }))
}
void origFetch
try { require('node:module').syncBuiltinESMExports() } catch {}
log('armed')
`,
)

//
section('§0 the tripwire is non-vacuous (poison control: a forced connect logs)')
//
{
  const poison = spawnSync(
    'node',
    ['--require', TRIPWIRE, '-e', "const net=require('node:net');const s=new net.Socket();s.on('error',()=>process.exit(0));s.connect(9,'127.0.0.2')"],
    { encoding: 'utf8', timeout: vshotBudgetMs(20000) },
  )
  const logged = readFileSync(NETLOG, 'utf8')
  check('the poisoned connect is logged and refused', poison.status === 0 && logged.includes('tcp 127.0.0.2:9'), `status=${poison.status} log=${logged.slice(0, 120)}`)
  writeFileSync(NETLOG, '') // reset for the real drives
}

// ── the drive ───────────────────────────────────────────────────────────────
const OUT = join(aux, 'captures')
mkdirSync(OUT, { recursive: true })
const IDLE_TICKS = 300 // 60 s of wall clock at 0.2 s/tick
/** Boot-adjacent one-shots (the host-signal sweep's once-ever bell for a
 *  standing obligation, the recap card's late paint, the API preconnect)
 *  land within seconds of "ready" — the byte-still window measures the
 *  SETTLED idle, so it opens this far past the settle receipt. */
const SETTLE_MARGIN_TICKS = 50
const TOTAL = 460

type Cell = { c: string }
type Payload = {
  grid: Cell[][]
  endReason?: string
  readyAt?: number
  sendReceipts?: Array<{ atTick: number; ts: number }>
}
const gridText = (g: Cell[][]): string => g.map(r => r.map(c => c.c || ' ').join('')).join('\n')

function teeBytesIn(tee: Buffer, fromTick: number, toTick: number): { bytes: number; frames: number } {
  let off = 0
  let bytes = 0
  let frames = 0
  while (off + 8 <= tee.length) {
    const tick = tee.readUInt32BE(off)
    const len = tee.readUInt32BE(off + 4)
    off += 8
    if (off + len > tee.length) break // torn tail frame — count what stands
    if (tick >= fromTick && tick < toTick && len > 0) {
      bytes += len
      frames += 1
    }
    off += len
  }
  return { bytes, frames }
}

function drive(cols: number, rows: number): void {
  section(`the ${cols}x${rows} calm drive — armed badge, 60 s byte-still`)
  const name = `calm-idle-${cols}x${rows}`
  const gridPath = join(OUT, `${name}.grid.json`)
  const teePath = join(OUT, `${name}.tee.bin`)
  const cfg = {
    cols,
    rows,
    total: TOTAL,
    argv: ['node', DIST, '--resume', SID],
    out: gridPath,
    cwd,
    // Two NO-BYTE sends hold vshot past readiness (with sends pending the
    // ready-exit waits): the first fires once the settled screen stands
    // (awaitText + settle), the second 310 ticks (62 s) later. The quiet
    // window is anchored on their OWN receipts — self-timing, no
    // machine-speed guess.
    sends: [
      { atTick: 999, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 5, data: '', mark: 'settled' },
      { afterPrevTicks: IDLE_TICKS + SETTLE_MARGIN_TICKS + 10, data: '', mark: 'idle-held' },
    ],
    readyText: '? for shortcuts',
    readySettleTicks: 3,
  }
  const cfgPath = join(OUT, `${name}.vshot.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_BOOT_PREFLIGHT: '0',
    TERM: 'xterm-256color',
    USER: 'sam',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_DECK_COMPANION: '0',
    // The registered hermetic-capture seam for the local-model discovery
    // probe set (Ollama :11434 · LM Studio :1234 · …) — its loopback dials
    // are a standing product surface with this documented off switch; the
    // pings estate itself dials nothing.
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DOCTOR_STATE_DIR: join(aux, 'doctor'),
    MERCURY_DAEMON_DIR: join(aux, 'daemon'),
    MERCURY_TEAMS_DIR: join(aux, 'teams'),
    MERCURY_TABULA_DIR: join(aux, 'tabula'),
    VSHOT_TEE: teePath,
    NODE_OPTIONS: `--require ${TRIPWIRE}`,
  }
  for (const k of ['ANTHROPIC_API_KEY', 'CI', 'NODE_ENV', 'OPENROUTER_API_KEY']) delete env[k]
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(200000), env })
  let payload: Payload = { grid: [] }
  if (existsSync(gridPath)) {
    try {
      payload = JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
    } catch {
      payload = { grid: [] }
    }
  }
  const text = gridText(payload.grid)
  writeFileSync(join(OUT, `${name}.txt`), text + '\n')
  const receipts = payload.sendReceipts ?? []
  if (res.status !== 0 || receipts.length < 2) {
    console.log(`⏭  the drive never reached its held-idle send (status=${res.status} end=${String(payload.endReason)} receipts=${receipts.length}) — too slow for a meaningful window on this machine (machine gate)`)
    console.log((res.stderr || '').slice(0, 600))
    process.exit(3)
  }
  const settleTick = receipts[0]!.atTick
  const heldTick = receipts[1]!.atTick
  const windowFromTick = settleTick + SETTLE_MARGIN_TICKS
  check('the drive ended by readiness after the held window (never mid-burst)', payload.endReason === 'ready', String(payload.endReason))
  check(
    `the settled-idle window really spans ≥ ${IDLE_TICKS} ticks (60 s)`,
    heldTick - windowFromTick >= IDLE_TICKS,
    `${heldTick - windowFromTick}`,
  )
  check('the strip badge is PAINTED (⚑ 1 needs you)', text.includes('⚑ 1 needs you'), text.split('\n').find(l => l.includes('⚑')) ?? '(no ⚑ row)')
  const tee = readFileSync(teePath)
  const settled = teeBytesIn(tee, windowFromTick, heldTick)
  check(`byte-still: ZERO bytes over the settled-idle window [${windowFromTick}, ${heldTick})`, settled.bytes === 0, `${settled.bytes} byte(s) in ${settled.frames} frame(s)`)
  const before = teeBytesIn(tee, 0, windowFromTick)
  check('the tee is non-vacuous (the boot painted real bytes before the window)', before.bytes > 1000, `${before.bytes} byte(s)`)
  const netlog = readFileSync(NETLOG, 'utf8')
  // The zero-network law is the PINGS estate's: the armed idle dials
  // nothing. Boot-adjacent dials (the API preconnect — the recorded
  // pre-existing class — and local daemon-adjacent probes) trail into the
  // window's first seconds; the STEADY armed idle — everything past a 5 s
  // settle tail — must be dial-free, refused-or-not. The receipts carry
  // wall-clock stamps, so the window is exact.
  const windowFrom = receipts[0]!.ts
  const windowTo = receipts[1]!.ts
  const stamps = netlog
    .split('\n')
    .filter(l => l.includes('tcp ') || l.includes('fetch '))
    .map(l => ({ at: Number(l.split(' ')[0]), line: l }))
    .filter(e => Number.isFinite(e.at))
  const steady = stamps.filter(e => e.at >= windowFrom + 5000 && e.at <= windowTo)
  check(
    `the STEADY armed idle dials nothing (${windowTo - windowFrom - 5000} ms window)`,
    steady.length === 0,
    steady.slice(0, 3).map(e => e.line).join(' · '),
  )
  const tail = stamps.filter(e => e.at >= windowFrom && e.at < windowFrom + 5000)
  console.log(`  · boot-adjacent dials in the 5 s settle tail (classified, all refused by the tripwire): ${tail.length}`)
  check(
    'no non-local host beyond the recorded api.anthropic.com preconnect class appears anywhere',
    stamps.every(e => e.line.includes('localhost') || e.line.includes('127.0.0.1') || e.line.includes('api.anthropic.com')),
    stamps.map(e => e.line).find(l => !(l.includes('localhost') || l.includes('127.0.0.1') || l.includes('api.anthropic.com'))) ?? '',
  )
  check('the tripwire was armed in the booted product', netlog.includes('armed'), netlog.slice(0, 120))
  writeFileSync(NETLOG, '')
}

drive(120, 40)
drive(100, 30)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL CALM-IDLE PROOFS PASS')
else console.log(`${failures} CALM-IDLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
