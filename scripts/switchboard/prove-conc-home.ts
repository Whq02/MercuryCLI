#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-conc-home.ts — THE CONCOURSE RE-HOME LAW
//  (the operator's sighting: "when I switch back to that
//  project's main folder again in the concourse … it stays in the other
//  projects … does not rehome it back", and their screenshot's one-frame
//  self-contradiction: a session in PARKED while the elsewhere door said
//  "1 running in <the same project> — switch to see them" on the SAME
//  board). THE ADJUDICATED MECHANISM (on the operator's own disk): a
//  session born with the project's `.mercury` CONFIG HOME as its workspace
//  minted a twin store and classed as ANOTHER project — wearing the
//  PARENT's display name (the ruled naming rule) while carrying a foreign
//  key. The fix is the config-home fold at the ONE key derivation
//  (getProjectDir); this prover drives the composed board through the REAL
//  switch door over seeded records.
//
//   §1  THE FRAME CANNOT COMPOSE: on the project's own board a
//       `.mercury`-grounded running session is a CURRENT row — never an
//       elsewhere door naming the board's own project beside its own
//       parked rows.
//   §2  THE ROUND TRIP REHOMES: A → B → A through the picker's real path
//       (the seed write + the ground apply). Away: the session counts on
//       A's door, named by A. Back: the session is a board row again; no
//       same-project door survives.
//   §3  THE TWIN PICKER ROWS LAND ONE BOARD: switching to the `.mercury`
//       spelling itself (the twin row the store scan once offered) lands
//       the SAME board — same label, same current rows, same parked pile.
//  (The never-again invariant over the composed snapshot — an independent
//  oracle, not the join under test — is §4, landed with the invariant
//  commit.)
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'conc-home-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
// Every store the builder reads lives in scratch: this prover owns what it
// reads (proof hygiene — the operator's real home is never touched).
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const { buildConcourseSnapshot, writeConcourseSeedOverride } = await import('../../src/services/concourse/concourseSnapshot.ts')
const { applyHarnessGround } = await import('../../src/services/switchboard/harnessGround.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

const NOW = Date.now()
const recordsDir = join(SCRATCH, 'daemon')
const crewDir = join(SCRATCH, 'crew')
const draftDir = join(SCRATCH, 'draft')
for (const d of [recordsDir, crewDir, draftDir]) mkdirSync(d, { recursive: true })

function seedWorkers(records: ConcourseWorkerRecordV1[]): void {
  const workers = Object.fromEntries(records.map(r => [r.runnerId, r]))
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
}
function liveRecord(runnerId: string, sessionId: string, workspaceId: string, extra: Partial<ConcourseWorkerRecordV1> = {}): ConcourseWorkerRecordV1 {
  return {
    schema: 1,
    runnerId,
    sessionId,
    workspaceId,
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 7 * 60_000,
    lastLiveAt: NOW,
    pid: process.pid,
    title: `chat ${sessionId.slice(-2)}`,
    ...extra,
  } as ConcourseWorkerRecordV1
}
function transcriptRows(cwd: string, sessionId: string, words: string): Record<string, unknown>[] {
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date(NOW).toISOString(),
    ...extra,
  })
  const reply = row({
    type: 'assistant',
    message: { id: `msg_${sessionId.slice(-4)}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  return [row({ type: 'user', message: { role: 'user', content: words } }), reply]
}
/** Seed a chat where the path law puts its file (the workspace's project
 *  store — for a `.mercury` workspace that is the PARENT's store now). */
function seedChat(workspaceId: string, sessionId: string, words: string): string {
  const file = workerTranscriptPath({ sessionId, workspaceId })
  mkdirSync(workspaceId, { recursive: true })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(transcriptRows(workspaceId, sessionId, words) as never, sessionId))
  return file
}
const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`
const build = (): ReturnType<typeof buildConcourseSnapshot> => buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: NOW })
/** THE SWITCH, the picker's own path: the seed write, then the ground apply. */
async function switchTo(dir: string): Promise<void> {
  await writeConcourseSeedOverride({ projectDir: dir }, draftDir)
  await applyHarnessGround(dir)
}

// The estate: the operator's shape — a project root, its `.mercury` config
// home, a second project. One session RUNS with the config home as its
// workspace (the adjudicated birth); one parked chat lives in the root.
const P_HOME = join(SCRATCH, 'One Shot Prompt')
const CONFIG = join(P_HOME, '.mercury')
const P_B = join(SCRATCH, 'proj-other')
mkdirSync(CONFIG, { recursive: true })
mkdirSync(P_B, { recursive: true })
const S_RUN = sid('a1') // running, `.mercury`-grounded (the disease's birth)
const S_PARK = sid('a2') // parked chat of the root (no record)
const S_B1 = sid('b1') // the other project's own running session

seedChat(CONFIG, S_RUN, 'the running one')
seedChat(P_HOME, S_PARK, 'the parked one')
seedChat(P_B, S_B1, 'other project work')
seedWorkers([liveRecord('concourse-w1', S_RUN, CONFIG), liveRecord('concourse-w2', S_B1, P_B)])

// ── §1: the frame cannot compose ────────────────────────────────────────────
console.log('§1 — THE FRAME CANNOT COMPOSE: a `.mercury`-grounded running session is a CURRENT row on its project\'s own board')
{
  check('the write side stores the `.mercury`-grounded chat PARENT-side (one store, no twin)', workerTranscriptPath({ sessionId: S_RUN, workspaceId: CONFIG }).startsWith(getProjectDir(P_HOME)), workerTranscriptPath({ sessionId: S_RUN, workspaceId: CONFIG }))
  await switchTo(P_HOME)
  const snap = await build()
  const flat = snap.groups.flatMap(g => g.rows)
  check('the board names the project (the ruled display name)', snap.context.projectLabel === basename(P_HOME), snap.context.projectLabel)
  check('the running `.mercury`-grounded session is a BOARD ROW (classed current, working)', flat.find(r => r.sessionId === S_RUN)?.state === 'working', flat.map(r => `${r.sessionId.slice(-2)}:${r.state}`).join(','))
  check('the parked chat paints beside it (the frame\'s parked half, intact)', snap.groups.find(g => g.id === 'parked')?.rows.some(r => r.sessionId === S_PARK) === true)
  check('NO elsewhere door names the board\'s own project (the operator\'s contradiction is dead)', !(snap.elsewhere ?? []).some(p => p.name === basename(P_HOME)), (snap.elsewhere ?? []).map(p => p.name).join(','))
  check('the OTHER project still counts on its door (the door law untouched)', (snap.elsewhere ?? []).some(p => p.name === basename(P_B) && p.running === 1))
}

// ── §2: the round trip rehomes ──────────────────────────────────────────────
console.log('§2 — THE ROUND TRIP REHOMES: A → B → A through the picker\'s real path leaves no same-project elsewhere door')
{
  await switchTo(P_B)
  const away = await build()
  const awayFlat = away.groups.flatMap(g => g.rows)
  check('away at B: the session counts on A\'s door, named by A (the correct half the operator saw)', (away.elsewhere ?? []).some(p => p.name === basename(P_HOME) && p.running === 1), (away.elsewhere ?? []).map(p => `${p.name}:${p.running}`).join(','))
  check('away at B: nothing of A rides B\'s board as a row', !awayFlat.some(r => r.sessionId === S_RUN || r.sessionId === S_PARK))
  await switchTo(P_HOME)
  const back = await build()
  const backFlat = back.groups.flatMap(g => g.rows)
  check('back at A: the running session REHOMED — a board row again (the sighting\'s exact gesture, healed)', backFlat.find(r => r.sessionId === S_RUN)?.state === 'working')
  check('back at A: no same-project elsewhere door survives the round trip', !(back.elsewhere ?? []).some(p => p.name === basename(P_HOME)))
  check('back at A: the parked pile is the project\'s own again', back.groups.find(g => g.id === 'parked')?.rows.some(r => r.sessionId === S_PARK) === true)
}

// ── §3: the twin picker rows land one board ─────────────────────────────────
console.log('§3 — THE TWIN PICKER ROWS LAND ONE BOARD: the `.mercury` spelling itself is the same ground')
{
  await switchTo(CONFIG)
  const viaConfig = await build()
  const flat = viaConfig.groups.flatMap(g => g.rows)
  check('the `.mercury` spelling wears the PARENT\'s name (the ruled display rule, unchanged)', viaConfig.context.projectLabel === basename(P_HOME), viaConfig.context.projectLabel)
  check('the running session is a current row here too (the twin rows merged — one key)', flat.find(r => r.sessionId === S_RUN)?.state === 'working')
  check('the parked pile is the SAME pile (the parent store — no twin store listing)', viaConfig.groups.find(g => g.id === 'parked')?.rows.some(r => r.sessionId === S_PARK) === true)
  check('no elsewhere door names this project from its own `.mercury` ground', !(viaConfig.elsewhere ?? []).some(p => p.name === basename(P_HOME)))
}

// ── §4: the never-again invariant ───────────────────────────────────────────
console.log('§4 — THE NEVER-AGAIN INVARIANT: no board classes one folder\'s rows both current and elsewhere, whatever the spelling class')
{
  // THE INDEPENDENT ORACLE (the ruling's discipline): folder identity
  // recomputed HERE — realpath, NFC, a local config-home fold — never the
  // join under test. A future divergence class in the product's join reds
  // against this oracle even if the join agrees with itself.
  const { realpathSync } = await import('node:fs')
  const oracle = (dir: string): string => {
    let canonical: string
    try {
      canonical = realpathSync(dir).normalize('NFC')
    } catch {
      canonical = dir.normalize('NFC')
    }
    if (basename(canonical) === '.mercury') {
      const parent = dirname(canonical)
      if (basename(parent).length > 0 && basename(parent) !== '.mercury') return parent
    }
    return canonical
  }
  // The divergence classes seeded as live rows: the config-home spelling,
  // the raw alias spelling (mkdtemp answers /var/… while the truth is
  // /private/var/…), a trailing separator — plus the recognition classes
  // (frontier smart-recognition, operator-ruled): an ordinary
  // subdir now belongs to the enclosing project on EVERY surface (the
  // walk-up arm), a subdir that is ITSELF a cataloged ground stays its own
  // project (the nearest-root carve), and a genuinely different folder
  // wearing the SAME leaf name stays elsewhere.
  const aliasSpelling = SCRATCH.startsWith('/private/') ? P_HOME.replace(/^\/private\//, '/') : P_HOME
  const SUB = join(P_HOME, 'csgo-prototype')
  const CARVED = join(P_HOME, 'carved-ground')
  const SCRATCH2 = mkdtempSync(join(tmpdir(), 'conc-home-twin-'))
  const SAME_NAME = join(SCRATCH2, basename(P_HOME))
  mkdirSync(SUB, { recursive: true })
  mkdirSync(CARVED, { recursive: true })
  mkdirSync(SAME_NAME, { recursive: true })
  const { catalogFirstChat, _resetProjectCatalogForTesting } = await import('../../src/utils/bootCardFacts.ts')
  catalogFirstChat(CARVED, sid('a7'))
  _resetProjectCatalogForTesting()
  seedWorkers([
    liveRecord('concourse-w1', S_RUN, CONFIG),
    liveRecord('concourse-w2', sid('a3'), aliasSpelling),
    liveRecord('concourse-w3', sid('a4'), P_HOME + '/'),
    liveRecord('concourse-w4', sid('a5'), SUB),
    liveRecord('concourse-w5', sid('a6'), SAME_NAME),
    liveRecord('concourse-w6', sid('a8'), CARVED),
  ])
  await switchTo(P_HOME)
  const snap = await build()
  const flat = snap.groups.flatMap(g => g.rows)
  const currentOracle = oracle(P_HOME)
  const offenders = (snap.elsewhere ?? []).filter(p => oracle(p.dir) === currentOracle)
  check('THE INVARIANT: no elsewhere entry resolves (by the independent oracle) to the board\'s own folder — red on ANY future divergence class', offenders.length === 0, offenders.map(p => p.dir).join(','))
  check('every spelling of the board\'s folder classes CURRENT (the config home, the raw alias, the trailing separator — all board rows)', [S_RUN, sid('a3'), sid('a4')].every(s => flat.some(r => r.sessionId === s && r.door === undefined)), flat.map(r => r.sessionId.slice(-2)).join(','))
  check('THE WALK-UP ARM: an ordinary subdir\'s session is a BOARD ROW of the enclosing project (one law on every surface — the picker/board split is retired)', flat.some(r => r.sessionId === sid('a5')) && !(snap.elsewhere ?? []).some(p => oracle(p.dir) === oracle(SUB)), flat.map(r => r.sessionId.slice(-2)).join(','))
  check('THE CARVE: a subdir that is ITSELF a cataloged ground stays legally elsewhere (nearest root wins — its sessions are its own)', !flat.some(r => r.sessionId === sid('a8')) && (snap.elsewhere ?? []).some(p => oracle(p.dir) === oracle(CARVED)))
  check('POSITIVE CONTROL: a different real folder wearing the SAME leaf name is legally elsewhere (two projects may share a name)', (snap.elsewhere ?? []).some(p => oracle(p.dir) === oracle(SAME_NAME)) && oracle(SAME_NAME) !== currentOracle)
  rmSync(SCRATCH2, { recursive: true, force: true })
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ ALL CONC-HOME PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
