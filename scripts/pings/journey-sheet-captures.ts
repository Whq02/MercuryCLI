// ============================================================================
//  scripts/pings/journey-sheet-captures.ts — the pings surface's visible lines
//  driven LIVE on the built bundle at 120x40 and 100x30:
//
//    Leg A (lines 1 + 2): an idle chat with NO needs; a sidecar process
//      raises a durable obligation mid-drive — the ⚑ badge APPEARS on the
//      strip (before/after marks) and EXACTLY ONE lone bell byte rides the
//      wire (the one-tap law across both writers); the badge's advertised
//      key (ctrl+x c) then jumps to the board, whose NEEDS-YOU group lists
//      the question.
//    Leg B (line 3): a parked model switch stands at boot; the sidecar
//      publishes the daemon's settled facts mid-drive — the one grey note
//      ("model switched to X for this session") paints in THAT chat.
//    Leg C (line 5): /pings toggles the bell — the receipt says quiet, a
//      second toggle says ringing; the rows stay either way.
//
//  Machine gate: python3+pyte and a fresh dist, else exit 3. Set
//  PINGS_CAPTURE_OUT=<dir> to also copy the final grids there (the lane
//  receipt points at them).
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun', 'bin', 'bun')

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

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')

const SID = '00000000-aaaa-bbbb-cccc-000000000077'
const CAPTURE_OUT = process.env.PINGS_CAPTURE_OUT

type World = { home: string; cwd: string; aux: string; out: string }
function makeWorld(tag: string): World {
  const scratch = mkdtempSync(join(tmpdir(), `pings-cap-${tag}-`))
  const home = join(scratch, 'home')
  const aux = join(scratch, 'aux')
  const out = join(aux, 'captures')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(scratch, 'cwd'), { recursive: true })
  mkdirSync(out, { recursive: true })
  const cwd = realpathSync(join(scratch, 'cwd')).normalize('NFC')
  spawnSync('git', ['init', '-q'], { cwd })
  seedFirstRun(home, [cwd])
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
      requestId: 'req_cap1',
      message: {
        id: 'msg_cap1',
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
    const outRow = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...r, uuid, parentUuid: prev }
    prev = uuid
    return outRow
  })
  const projDir = join(home, 'projects', sanitizePath(cwd))
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, `${SID}.jsonl`), rows.map(l => JSON.stringify(entryToRecord(l as never, ctx as never))).join('\n') + '\n')
  return { home, cwd, aux, out }
}

function baseEnv(w: World, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: w.home,
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
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DOCTOR_STATE_DIR: join(w.aux, 'doctor'),
    MERCURY_DAEMON_DIR: join(w.aux, 'daemon'),
    MERCURY_TEAMS_DIR: join(w.aux, 'teams'),
    MERCURY_TABULA_DIR: join(w.aux, 'tabula'),
    ...extra,
  }
  for (const k of ['ANTHROPIC_API_KEY', 'CI', 'NODE_ENV', 'OPENROUTER_API_KEY']) {
    if (!(k in extra)) delete env[k]
  }
  return env
}

type Cell = { c: string }
type Send = { atTick?: number; afterPrevTicks?: number; awaitText?: string; minTick?: number; awaitSettleTicks?: number; data: string; mark?: string }
type Payload = { grid: Cell[][]; endReason?: string; marks?: Array<{ label: string; atTick: number; grid: Cell[][] }>; sendReceipts?: Array<{ atTick: number; ts: number }> }
const gridText = (g: Cell[][]): string => g.map(r => r.map(c => c.c || ' ').join('')).join('\n')
const flat = (s: string): string => s.replace(/[│╭╮╰╯─▔◆]/g, ' ').replace(/\s+/g, ' ')

function capture(
  w: World,
  name: string,
  cols: number,
  rows: number,
  sends: Send[],
  total: number,
  tee = false,
  opts: { bareBoot?: boolean; readyText?: string } = {},
): { text: string; marks: Record<string, string>; payload: Payload; teePath: string } {
  const gridPath = join(w.out, `${name}.grid.json`)
  const teePath = join(w.out, `${name}.tee.bin`)
  const cfg = {
    cols,
    rows,
    total,
    argv: opts.bareBoot === true ? ['node', DIST] : ['node', DIST, '--resume', SID],
    out: gridPath,
    cwd: w.cwd,
    sends,
    readyText: opts.readyText ?? '? for shortcuts',
    readySettleTicks: 3,
  }
  const cfgPath = join(w.out, `${name}.vshot.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const env = baseEnv(w, tee ? { VSHOT_TEE: teePath } : {})
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(180000), env })
  let payload: Payload = { grid: [] }
  if (existsSync(gridPath)) {
    try {
      payload = JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
    } catch {
      payload = { grid: [] }
    }
  }
  const text = gridText(payload.grid)
  writeFileSync(join(w.out, `${name}.txt`), text + '\n')
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) {
    marks[m.label] = gridText(m.grid)
    writeFileSync(join(w.out, `${name}.mark-${m.label}.txt`), marks[m.label] + '\n')
  }
  if (res.status !== 0) writeFileSync(join(w.out, `${name}.stderr.txt`), (res.stderr || '') + '\n')
  if (CAPTURE_OUT) {
    mkdirSync(CAPTURE_OUT, { recursive: true })
    copyFileSync(join(w.out, `${name}.txt`), join(CAPTURE_OUT, `${name}.txt`))
    for (const m of Object.keys(marks)) copyFileSync(join(w.out, `${name}.mark-${m}.txt`), join(CAPTURE_OUT, `${name}.mark-${m}.txt`))
  }
  return { text, marks, payload, teePath }
}

/** Detached sidecar: run `script` under bun in the world's env after
 *  `delayMs` (its own sleep) — the mid-drive actor a blocked spawnSync
 *  cannot be. */
function sidecar(w: World, delayMs: number, script: string): void {
  const body = `await new Promise(r => setTimeout(r, ${delayMs}));\n${script}`
  const child = spawn(BUN, ['-e', body], {
    cwd: ROOT,
    env: baseEnv(w),
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

function loneBellFrames(teePath: string, fromTick: number): number {
  const data = readFileSync(teePath)
  let off = 0
  let count = 0
  while (off + 8 <= data.length) {
    const tick = data.readUInt32BE(off)
    const len = data.readUInt32BE(off + 4)
    off += 8
    if (off + len > data.length) break
    if (tick >= fromTick && len === 1 && data[off] === 0x07) count += 1
    off += len
  }
  return count
}

const SIZES: Array<[number, number]> = [
  [120, 40],
  [100, 30],
]

for (const [cols, rows] of SIZES) {
  //
  section(`Leg A ${cols}x${rows} — a session taps you: the badge appears, one bell, the key jumps to the board`)
  //
  {
    const w = makeWorld(`a-${cols}x${rows}`)
    sidecar(
      w,
      14_000,
      `const o = await import('${ROOT}/src/services/crew/obligations.ts')
await o.upsertObligation({ ref: 'tap-live-1', sessionId: '${SID}', question: 'May I run the migration?', owner: 'operator', dir: '${join(w.home, 'crew')}', scope: 'switchboard' })`,
    )
    const c = capture(
      w,
      `taps-${cols}x${rows}`,
      cols,
      rows,
      [
        { atTick: 999, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 5, data: '', mark: 'before' },
        { afterPrevTicks: 100, data: '', mark: 'tapped' },
        { afterPrevTicks: 5, data: '\x18' },
        { afterPrevTicks: 3, data: 'c' },
        { afterPrevTicks: 40, data: '', mark: 'board' },
      ],
      260,
      true,
    )
    const settleTick = c.payload.sendReceipts?.[0]?.atTick ?? -1
    check('the drive settled and ran its sends', settleTick >= 0 && (c.payload.sendReceipts?.length ?? 0) >= 5, `receipts=${c.payload.sendReceipts?.length}`)
    check('before the tap: no badge', !(c.marks['before'] ?? '').includes('⚑'), '(⚑ present early)')
    check('the tap paints the badge (⚑ 1 needs you)', (c.marks['tapped'] ?? '').includes('⚑ 1 needs you'), (c.marks['tapped'] ?? '').split('\n').find(l => l.includes('⚑')) ?? '(no ⚑ row)')
    check(
      'EXACTLY ONE lone bell byte after the settle (one tap across both writers)',
      loneBellFrames(c.teePath, settleTick + 10) === 1,
      `lone-bell frames=${loneBellFrames(c.teePath, settleTick + 10)}`,
    )
    // The concourse paints some regions with per-cell styling that drops
    // inter-word spaces in the pyte grid text — match space-collapsed.
    const board = flat(c.marks['board'] ?? '').replace(/ /g, '')
    check('the advertised key jumps to the board', board.includes('SESSIONCONCOURSE'), board.slice(0, 160))
    check("the board's NEEDS-YOU group lists the question", board.includes('NEEDSYOU') && board.includes('MayIrunthemigration'), board.slice(0, 240))
  }

  //
  section(`Leg B ${cols}x${rows} — the model-switched grey note paints in THAT chat`)
  //
  {
    const w = makeWorld(`b-${cols}x${rows}`)
    const factsBase = `{
  schema: 1, sessionId: '${SID}', atMs: Date.now(), busy: BUSY, pendingModel: PENDING,
  model: { effective: EFFECTIVE, setting: EFFECTIVE },
  usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
  identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
  skills: [], mcp: [], permissionMode: 'default', queue: [],
  workspace: { cwd: '${w.cwd}', originalCwd: '${w.cwd}', projectRoot: '${w.cwd}', instructionRoots: [] },
}`
    // The parked switch stands BEFORE boot (the constructor's first read).
    {
      const seed = spawnSync(
        BUN,
        [
          '-e',
          `const s = await import('${ROOT}/src/services/engine-connector/seatProjections.ts')
s.publishSessionFacts(${factsBase.replace('BUSY', 'true').replace('PENDING', "'claude-fable-5'").replace(/EFFECTIVE/g, "'claude-opus-5'")})
await new Promise(r => setTimeout(r, 400))`,
        ],
        { cwd: ROOT, env: baseEnv(w), encoding: 'utf8', timeout: vshotBudgetMs(30000) },
      )
      if (seed.status !== 0) {
        check('rig: the parked facts seeded', false, (seed.stderr || '').slice(0, 200))
        continue
      }
    }
    sidecar(
      w,
      22_000,
      // The settle publish carries the daemon's OWN settlement receipt
      // (modelSettled — FN-016 R15), exactly as the idle-edge apply
      // publishes it: the screen's note edge drives off the stamp, never
      // off the effective/pending coincidence this fixture used to model.
      `const s = await import('${ROOT}/src/services/engine-connector/seatProjections.ts')
s.publishSessionFacts({ ...${factsBase.replace('BUSY', 'false').replace('PENDING', 'null').replace(/EFFECTIVE/g, "'claude-fable-5'")}, modelSettled: { from: 'claude-opus-5', to: 'claude-fable-5', atMs: Date.now() } })
await new Promise(r => setTimeout(r, 400))`,
    )
    // The settle seam lives on the MANAGED path: a bare boot lands on the
    // Boot face (the landing rule) and the face's CONTINUE row (↓ ↵ — the
    // world seeds SID in the cwd project, so the row names it) arms
    // '/resume <sid>' into the root REPL, which hops into the session
    // through focusResumedSession — the connector whose facts feed the note
    // rides (the argv --resume painting path does not build it). Under the
    // one-door law ↵ on New Session BIRTHS a session (it needs the daemon,
    // dead here by design) — so the road is the Continue row, never a
    // typed /resume into a chat that no longer pre-exists.
    // The hop's background daemon heal would admit
    // the session and publish REAL facts over the fixture park — the
    // daemon dir goes read-only (its session-facts subdir stays writable),
    // so the socket bind fails deterministically, the refusal paints its
    // one line, and the fixture settlement drives the seam.
    mkdirSync(join(w.aux, 'daemon', 'session-facts'), { recursive: true })
    chmodSync(join(w.aux, 'daemon'), 0o555)
    const c = capture(
      w,
      `switch-note-${cols}x${rows}`,
      cols,
      rows,
      [
        { atTick: 999, awaitText: 'Continue Last Session', minTick: 5, awaitSettleTicks: 4, data: '\x1b[B' },
        { afterPrevTicks: 3, data: '\r' },
        { atTick: 999, awaitText: 'settled and idle', minTick: 5, awaitSettleTicks: 5, data: '', mark: 'parked' },
        { afterPrevTicks: 120, data: '', mark: 'note' },
      ],
      280,
      true,
      { bareBoot: true },
    )
    chmodSync(join(w.aux, 'daemon'), 0o755)
    const note = flat(c.marks['note'] ?? '')
    check('the hop painted the session (the parked mark holds the chat)', (c.marks['parked'] ?? '').includes('settled and idle'), 'no transcript in the parked mark')
    check('the settle paints the ruled grey note in THAT chat', note.includes('model switched to') && note.includes('for this session'), note.slice(0, 240))
    check('the note names the settled model', note.includes('model switched to Fable'), note.match(/model switched to [^·]{0,40}/)?.[0] ?? '(absent)')
    const hopTick = c.payload.sendReceipts?.[2]?.atTick ?? -1
    check('the settle never rings the bell (no lone bell byte after the hop)', loneBellFrames(c.teePath, hopTick + 5) === 0, `frames=${loneBellFrames(c.teePath, hopTick + 5)}`)
  }

  //
  section(`Leg C ${cols}x${rows} — /pings toggles the bell; the receipt says so`)
  //
  {
    const w = makeWorld(`c-${cols}x${rows}`)
    const c = capture(
      w,
      `pings-toggle-${cols}x${rows}`,
      cols,
      rows,
      [
        { atTick: 999, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 5, data: '' },
        { afterPrevTicks: 10, data: '/pings' },
        { afterPrevTicks: 8, data: '\r' },
        { afterPrevTicks: 20, data: '', mark: 'off' },
        { afterPrevTicks: 5, data: '/pings' },
        { afterPrevTicks: 8, data: '\r' },
        { afterPrevTicks: 20, data: '', mark: 'on' },
      ],
      180,
    )
    const off = flat(c.marks['off'] ?? '')
    const on = flat(c.marks['on'] ?? '')
    check('the first toggle answers quiet (pings off — rows stay)', off.includes('pings off') && off.includes('still say'), off.match(/pings off[^·]{0,60}/)?.[0] ?? off.slice(0, 160))
    check('the second toggle answers ringing (pings on)', on.includes('pings on'), on.match(/pings on[^·]{0,60}/)?.[0] ?? on.slice(0, 160))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL SHEET-CAPTURE PROOFS PASS')
else console.log(`${failures} SHEET-CAPTURE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
