#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-cross-project.ts — CROSS-PROJECT AWARENESS
//  (the spec ledger's L9 + L10, the operator's words; lane 7).
//  THE INVARIANT: the board = the current project's sessions + the one
//  focused session (★ if foreign) + a running-count line per other project
//  with activity; switching projects moves your eyes, never your sessions.
//  Executed units over the REAL builder, the REAL stores and the REAL
//  switch door in a scratch home, plus source seams — no boot (the pool's
//  drive is prove-cross-project-drive.ts).
//
//   §1  SWITCHING NEVER TOUCHES A SESSION: a switch (the REPO picker's path
//       — the seed write + applyHarnessGround) changes the board's VIEW
//       only. A daemon with sessions in A and B; switch A→B→A: every record
//       byte-identical, the obligations byte-identical, no delta stamp, the
//       focused slot untouched; the view follows. POISON CONTROL: a real
//       lifecycle write (the focus stamp) moves the bytes — the comparator
//       has teeth. The chip is BOOT-SCOPED: a projectDir an earlier boot
//       left in the file never steers the ground resolver or the board.
//       The daemon's reconcile/idle paths read no UI ground.
//   §2  THE FOCUSED SESSION CARRIES OVER (★): the board filters by project,
//       then always adds the one focused session, wherever it lives — its
//       row wears ✦ "from <its project>" beside the title, keeps its own
//       state and NOW cell, its own workspace; hasFocusedSession() stays
//       true and the chat stop stays on the strip (the router untouched).
//       With NO live record the carried chat is a parked ★ row (first in
//       PARKED, its transcript on the row — ↵ rides the one parked arm).
//       POISON CONTROL: with no focus nothing of A rides B's board.
//   §3  A NEW FOCUS HANDS IT BACK SILENTLY: focusing a session of the
//       current project releases the carried-over row from THIS board — it
//       is back to a normal row in ITS project, running as it was; no
//       notice, no NEEDS YOU, no obligation, no record byte moved (the
//       hop's blur is the daemon's one moving fact, and only on the real
//       hop). The board re-derives on the slot's own beat.
//   §4  THE RUNNING-COUNT LINE, A DOOR: one line per OTHER project with
//       activity — "N running in foo" (· needs you · finished), "switch to
//       see them" — from the ONE activity owner over the daemon's whole
//       roster grouped by the catalog's key; its own group (OTHER PROJECTS)
//       after the current project's live groups and BEFORE parked; bounded
//       to three by activity, painted in NAME order (content-keyed, a count
//       change never re-sorts), "+N more" honest and a door to the picker;
//       ↵ on a line = the REPO picker's own switch path (the trust gate
//       included — never a second switcher); the carried-over ★ session is
//       not counted where it came from; no tile subscribes to a door row.
//   §5  THE CROSS-PROJECT PING, A DOOR: a need raised by a session of
//       another project rows on the rail as "switch to <name> · needs you"
//       (its question kept, ITS project named) with 'switch & open' as its
//       one affordance; a FINISH in another project mints ONE need of the
//       new kind (ref cross-project:finished:<sid>:<settledAt>) through the
//       obligations owner's door — seed-silent at the first beat, once per
//       settle, never re-minted, never for the current project; the ⚑
//       counts both like any need (the attention fold), PINGS's engine
//       rings each subject once (its own shapes: the bridge's translation,
//       the fold, the slice); ↵/o = switch + open (the trust gate kept);
//       the finished kind settles on its door; the host toast names it;
//       nothing of it in the plain world.
//   §6  THE INDICATOR ON THE BOOT FACE: the Projects rows read the same
//       running count from the same owner ("foo · 3 running" alone, "foo (3
//       running)" in the list, the accent note before the age in the
//       picker); a row without a count composes the exact bytes it always
//       did (the launcher seam stays byte-identical); absent in the plain
//       world.
//   §7  THE ANNEX (ledgered to this lane — FOLDERPROJ's follow-ups): the
//       seed chip's boot scope (§1) and the card-aware Projects-↵: a folder
//       whose only chat is a wordless LIVE newborn hops into it (the card's
//       firstSessionId) instead of birthing a second chat beside it. (The
//       reduced stage's key-map bands are CONCRESUME's, landed on main.)
//   §8  SESSION-AWARE NAMING (L16): three stages through ONE owner — the
//       stored title, else the chat's first words, else "new session ·
//       <project> · ready" — and NEVER a worker id, in any world; the
//       model-minted title lands ONCE at the second assistant turn through
//       the estate's existing small call and the daemon's set-title door
//       (minted fills an EMPTY title only; titleMintedAt stamps once at the
//       record's one writer; a typed /title or board rename always lands
//       and survives; a failed mint leaves stage 2 — the name never
//       regresses). Poisons: a mint at turn one; a second mint; a minted
//       word over a typed one; 'concourse-wN' as any surface's title.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'cross-project-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
// Every store the builder reads — the config home, the session store, the
// coordinator resolution — lives in scratch: this prover owns what it reads.
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
/** Source reads anchor on the repo root — the real switch door chdirs. */
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const snapshotMod = await import('../../src/services/concourse/concourseSnapshot.ts')
const { buildConcourseSnapshot, bootScopedSeedOverrides, readConcourseSeedOverrides, resolveHarnessGround, writeConcourseSeedOverride } = snapshotMod
const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
const { applyHarnessGround } = await import('../../src/services/switchboard/harnessGround.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')
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
  return words.length > 0 ? [row({ type: 'user', message: { role: 'user', content: words } }), reply] : [reply]
}
/** Seed a chat of `project` where the path law puts its file. The folder is
 *  made BEFORE the path law is asked: a real workspace always exists when its
 *  transcripts store, and a path derived for an unmade folder resolves on a
 *  FAILED canonicalization — a raw-slug store the board's canonical-keyed
 *  reads never see. */
function seedChat(project: string, sessionId: string, words: string, ageMs: number): string {
  mkdirSync(project, { recursive: true })
  const file = workerTranscriptPath({ sessionId, workspaceId: project })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(transcriptRows(project, sessionId, words) as never, sessionId))
  const at = new Date(NOW - ageMs)
  utimesSync(file, at, at)
  return file
}
const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`
/** Every byte of a directory tree, in one stable string — the record
 *  comparator (a lifecycle write anywhere in the daemon or crew stores
 *  moves it). */
function treeBytes(dir: string): string {
  if (!existsSync(dir)) return ''
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${p.slice(dir.length)}\n${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out.join(String.fromCharCode(10) + " " + String.fromCharCode(10))
}
const build = (): ReturnType<typeof buildConcourseSnapshot> => buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: NOW })
/** THE SWITCH, the picker's own path: the seed write, then the ground apply
 *  (the cwd state moves, the slot pulses, nothing else). */
async function switchTo(dir: string): Promise<void> {
  await writeConcourseSeedOverride({ projectDir: dir }, draftDir)
  await applyHarnessGround(dir)
}

const P_A = join(SCRATCH, 'proj-alpha')
const P_B = join(SCRATCH, 'proj-beta')
const S_A1 = sid('a1')
const S_A2 = sid('a2')
const S_B1 = sid('b1')

// ── §1: switching never touches a session ───────────────────────────────────
console.log('§1 — SWITCHING NEVER TOUCHES A SESSION: a switch is a change of view; every record byte-identical across A→B→A')
{
  seedChat(P_A, S_A1, 'alpha one', 10 * 60_000)
  seedChat(P_A, S_A2, 'alpha two', 12 * 60_000)
  seedChat(P_B, S_B1, 'beta one', 9 * 60_000)
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A, { pausedAt: NOW - 60_000, pausedBy: 'operator' }), liveRecord('concourse-w3', S_B1, P_B)])
  await switchTo(P_A)
  const before = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir), delta: existsSync(supervisor.concourseDeltaPath(recordsDir)) }
  const atA = await build()
  check('the view at A names A', atA.context.projectLabel === basename(P_A), atA.context.projectLabel)
  await switchTo(P_B)
  const atB = await build()
  check('the view at B names B (the switch moved the eyes)', atB.context.projectLabel === basename(P_B), atB.context.projectLabel)
  const afterB = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir), delta: existsSync(supervisor.concourseDeltaPath(recordsDir)) }
  check('A→B: every daemon record is byte-identical (nothing paused, parked, retired, blurred or stamped)', afterB.daemon === before.daemon)
  check('A→B: the obligations store is byte-identical (no ask minted, none settled)', afterB.crew === before.crew)
  check('A→B: no delta stamp was published (no roster transition — the daemon never heard about the switch)', afterB.delta === before.delta && before.delta === false)
  check('A→B: the focused slot is untouched (no session focused before, none after)', slot.hasFocusedSession() === false && slot.landingInFlight() === false)
  await switchTo(P_A)
  const backA = await build()
  const afterA = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir), delta: existsSync(supervisor.concourseDeltaPath(recordsDir)) }
  check('B→A: the view names A again', backA.context.projectLabel === basename(P_A))
  check('B→A: every record still byte-identical to the start', afterA.daemon === before.daemon && afterA.crew === before.crew && afterA.delta === false)
  check('B→A: the paused session is still paused, the live ones still live (the records say so, unchanged)', (() => {
    const w = supervisor.readSessionWorkers(recordsDir)
    return w['concourse-w2']?.pausedAt === NOW - 60_000 && w['concourse-w1']?.endedAt === undefined && w['concourse-w3']?.endedAt === undefined && w['concourse-w1']?.focusedAt === undefined
  })())
  check('the switch door is the ground apply: the cwd state moved with it', getCwd() === P_A)

  // POISON CONTROL: a REAL lifecycle write moves the bytes — the comparator
  // above would have caught a switch that stamped anything.
  const stamped = supervisor.focusConcourseSession(S_B1, 'operator:1', recordsDir)
  check('POISON CONTROL: a lifecycle write (the focus stamp) changes the record bytes and publishes a delta — the comparator has teeth', stamped.outcome === 'applied' && treeBytes(recordsDir) !== before.daemon && existsSync(supervisor.concourseDeltaPath(recordsDir)))
  supervisor.blurConcourseSession(S_B1, 'operator:1', recordsDir)
  rmSync(supervisor.concourseDeltaPath(recordsDir), { force: true })

  // THE CHIP IS BOOT-SCOPED: a projectDir this boot wrote stands; one an
  // earlier boot left behind reads as unset everywhere (the resolver, the
  // builder) — never the leak of last week's repo into today's boot.
  const start = 5_000_000
  check('chip law (pure): a chip stamped before this boot reads as unset; its siblings survive', (() => {
    const scoped = bootScopedSeedOverrides({ projectDir: P_B, projectDirAt: start - 1, modelKey: 'fable' }, start)
    return scoped.projectDir === undefined && scoped.projectDirAt === undefined && scoped.modelKey === 'fable'
  })())
  check('chip law (pure): a chip stamped at/after this boot stands', bootScopedSeedOverrides({ projectDir: P_B, projectDirAt: start }, start).projectDir === P_B)
  check('chip law (pure): a stampless chip (a pre-law write) reads as unset', bootScopedSeedOverrides({ projectDir: P_B }, start).projectDir === undefined)
  await writeConcourseSeedOverride({ projectDir: P_B }, draftDir)
  const fresh = await readConcourseSeedOverrides(draftDir)
  check('the writer stamps the chip with the clock; the reader door honours a chip THIS boot wrote', fresh.projectDir === P_B && typeof fresh.projectDirAt === 'number' && fresh.projectDirAt >= NOW - 60_000)
  check('the ground resolver answers the fresh chip (the ground law within a boot)', (await resolveHarnessGround(draftDir)) === P_B)
  // Forge last week's chip: the same file, the stamp older than this
  // process (a second write patches the stamp alone — no restamp).
  await writeConcourseSeedOverride({ projectDirAt: Date.now() - Math.floor(process.uptime() * 1000) - 60_000 }, draftDir)
  const stale = await readConcourseSeedOverrides(draftDir)
  check('a chip an earlier boot left behind reads as UNSET through the reader door', stale.projectDir === undefined && stale.projectDirAt === undefined)
  check('the ground resolver answers the LIVE ground over the stale chip (the seed-chip follow-up)', (await resolveHarnessGround(draftDir)) === getCwd() && getCwd() === P_A)
  check('the stale chip is still in the file (the route\'s mount clears it — the reader door only stops it steering)', readFileSync(join(draftDir, 'concourse-draft.json'), 'utf8').includes(P_B))
  const staleBoard = await build()
  check('the board never follows a stale chip: the view is the live ground (A), not the chip (B)', staleBoard.context.projectLabel === basename(P_A))
  await writeConcourseSeedOverride({ projectDir: null }, draftDir)

  // The source seams: the switch path issues no daemon op; the daemon's
  // reconcile/idle paths read no UI ground; the board rebuilds on the beat.
  const ground = read('src/services/switchboard/harnessGround.ts')
  check('the ground door is the process truth only — no daemon RPC, no control op, no seat verb', !ground.includes('daemonControlRpc') && !ground.includes('sessionControl') && !ground.includes("'blur'") && !ground.includes("'focus'") && ground.includes('state.setCwdState(target)'))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const seedAt = route.indexOf('setDraftSeed: patch => {\n      seedWriteChain.current')
  const seedBody = route.slice(seedAt, route.indexOf('newSession: (opts?: { contractText?: string }) => {', seedAt))
  check('the picker\'s switch path is the seed write + the ground apply and nothing else (no rpc, no hop, no release)', seedAt !== -1 && seedBody.includes('m.applyHarnessGround(') && !seedBody.includes('daemonControlRpc') && !seedBody.includes('hopIntoBoardSession') && !seedBody.includes('focusResumedSession') && !seedBody.includes('sessionRelease'))
  const face = read('src/components/BootSplashScreen.tsx')
  const openAt = face.indexOf('const openProject = (p: BootProjectFact): AsyncListNote => {')
  const openBody = face.slice(openAt, face.indexOf('// ── the ORIGINAL rows', openAt))
  check('Projects-↵\'s switch half is the same two verbs (seed + ground apply); its enter is the operator\'s own hop, never a lifecycle op', openBody.includes('writeConcourseSeedOverride({ projectDir: p.dir })') && openBody.includes('ground.applyHarnessGround(p.dir)') && !openBody.includes('daemonControlRpc') && !openBody.includes('sessionControl'))
  check('the route rebuilds the board on the ground beat (the switch re-scopes the view within a beat)', route.includes('const unsubProject = subscribeCurrentProject(rebuild)') && route.includes('unsubProject()'))
  const sup = read('src/daemon/concourseSupervisor.ts')
  const reconcileAt = sup.indexOf('export function reconcileConcourseWorkers(')
  const reconcileBody = sup.slice(reconcileAt, sup.indexOf('\nexport function', reconcileAt + 10))
  const uiGround = ['getCwd(', 'seedOverrides', 'concourse-draft', 'currentProject(', 'resolveHarnessGround', 'projectDir']
  check('the daemon\'s reconcile pass is keyed on records and liveness alone — nothing on "the current project"', reconcileAt !== -1 && uiGround.every(needle => !reconcileBody.includes(needle)))
  const idle = read('src/daemon/idleRetirement.ts')
  check('the idle reaper is keyed on the session\'s own facts — nothing on "the current project"', uiGround.every(needle => !idle.includes(needle)))
  const recon = read('src/daemon/reconcileRecords.ts')
  check('the boot reconcile reads no UI ground', ['seedOverrides', 'concourse-draft', 'currentProject(', 'resolveHarnessGround'].every(needle => !recon.includes(needle)))
  const daemonFiles = readdirSync(join(ROOT, 'src', 'daemon')).filter(f => f.endsWith('.ts'))
  const daemonImportsUi = daemonFiles.filter(f => {
    const src = read(join('src', 'daemon', f))
    return src.includes('concourseSnapshot') || src.includes('bootCardFacts') || src.includes('harnessGround')
  })
  check('no daemon module imports the board\'s view stores or the catalog door (the daemon cannot know which project you look at)', daemonImportsUi.length === 0, daemonImportsUi.join(','))
  const builder = read('src/services/concourse/concourseSnapshot.ts')
  check('the builder\'s current project has ONE owner — the catalog door — and the chip reads through its boot scope', builder.includes('const project = opts.project ?? currentProject()') && builder.includes('return bootScopedSeedOverrides((await draftStore(dir).read()).seedOverrides ?? {})') && builder.includes("if (next.projectDir !== undefined) next.projectDirAt = Date.now()"))
  // /sessions ("this project") is the catalog door's consumer too: after a
  // rail repo switch the list shows the PICKED project's chats — never the
  // boot's root — and follows a switch while open.
  // RE-CUT at the conc-home fold: the picker's list machinery moved WHOLE
  // into the extracted core — the law is unmoved,
  // the needles read the core beside the view (the view keeps no resolution
  // spelling of its own).
  const manager = read('src/components/mercury-ui/screens/SessionManagerView.tsx')
  const pickerCore = read('src/components/mercury-ui/screens/sessionPickerModel.ts')
  check('/sessions resolves "this project" through the catalog door (currentProject().dir), never getProjectRoot, and re-runs on the door\'s beat', pickerCore.includes('const p = log.projectPath || currentProject().dir') && !manager.includes('getProjectRoot') && !pickerCore.includes('getProjectRoot') && pickerCore.includes('useSyncExternalStore(subscribeCurrentProject, () => currentProject().key, () => currentProject().key)'))
}

// ── §2: the focused session carries over (★) ────────────────────────────────
console.log('§2 — THE FOCUSED SESSION CARRIES OVER: the board filters by project, then always adds the one focused session, ★ from its own project')
{
  const { registerChatPresence, presentStripStops, stripKeyMapHintOf, _resetSurfaceRouteForTesting } = await import('../../src/context/surfaceRoute.ts')
  const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  // The presence seam exactly as the router registers it (SurfaceRouter's
  // own three lines) — the strip counts its chat stop from the slot.
  registerChatPresence({ present: () => slot.hasFocusedSession() || slot.landingInFlight(), subscribe: slot.subscribeFocusedSessionConnector })
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A), liveRecord('concourse-w3', S_B1, P_B)])
  await switchTo(P_A)
  // Focus X (= S_A1) in A: the slot re-points at its connector (the hop's
  // own re-point, without the feeds a proof needs no timers for).
  const connector = seat.daemonSessionConnectorFor({ sessionId: S_A1, runnerId: 'concourse-w1', title: 'alpha one', projectLabel: basename(P_A), workspaceId: P_A, home: paths.getProjectDir(P_A) })
  slot.setFocusedSessionConnector(connector)
  const atA = await build()
  const flatA = atA.groups.flatMap(g => g.rows)
  check('at A the board shows A\'s sessions and none of B\'s (the project filter is a view)', flatA.some(r => r.sessionId === S_A1) && flatA.some(r => r.sessionId === S_A2) && !flatA.some(r => r.sessionId === S_B1), flatA.map(r => r.sessionId.slice(-2)).join(','))
  check('at A the focused session is an ordinary row of its own project — no ★', flatA.find(r => r.sessionId === S_A1)?.foreignProject === undefined)
  await switchTo(P_B)
  const atB = await build()
  const flatB = atB.groups.flatMap(g => g.rows)
  const star = flatB.find(r => r.sessionId === S_A1)
  check('★ after the switch to B, X (focused, of A) is on B\'s board', star !== undefined, flatB.map(r => r.sessionId.slice(-2)).join(','))
  check('★ the row wears its project\'s name as the mark ("from alpha")', star?.foreignProject === basename(P_A), star?.foreignProject)
  check('★ the row keeps its own state and its NOW cell (live, read from its own tail)', star?.state === 'working' && typeof star?.nowLabel === 'string' && star.nowLabel.length > 0, `${star?.state} · ${star?.nowLabel}`)
  check('★ the row keeps its own workspace (the mirror reads its own home)', star?.workspaceDir === P_A)
  check('the OTHER A session (unfocused) is NOT on B\'s board — only the focused one carries over', !flatB.some(r => r.sessionId === S_A2))
  check('B\'s own session is a plain row (no mark)', flatB.find(r => r.sessionId === S_B1)?.foreignProject === undefined)
  check('hasFocusedSession() stays true across the switch (the slot never moved)', slot.hasFocusedSession() && slot.getFocusedSessionConnector().sessionId() === S_A1)
  check('the chat stop is present on the strip — shift+→ still enters it (the router untouched)', presentStripStops().includes('repl') && stripKeyMapHintOf('concourse', presentStripStops()).includes('⇧→ chat'))
  check('the seats stay GLOBAL under the view: counts.live counts every live record (3) while the board shows two live CHAT rows (the elsewhere door is a door, never a chat)', atB.counts.live === 3 && flatB.filter(r => r.state !== 'parked' && r.door === undefined).length === 2, `${atB.counts.live} / ${flatB.length}`)
  check('the peek lands on a board row (never on a hidden session)', atB.peek !== null && flatB.some(r => r.sessionId === atB.peek?.sessionId))
  // The ★ row with NO live record: a parked chat brought back and not yet
  // admitted, or a runner that died — it stays the operator's chat.
  seedWorkers([liveRecord('concourse-w3', S_B1, P_B)])
  const noRec = await build()
  const parkedGroup = noRec.groups.find(g => g.id === 'parked')?.rows ?? []
  const parkedStar = parkedGroup.find(r => r.sessionId === S_A1)
  check('★ with no live record the focused foreign chat stays on the board — parked, first in PARKED, its transcript on the row for the one parked arm', parkedStar !== undefined && parkedStar.state === 'parked' && parkedStar.foreignProject === basename(P_A) && parkedStar.transcriptPath === workerTranscriptPath({ sessionId: S_A1, workspaceId: P_A }) && parkedGroup[0]?.sessionId === S_A1, parkedGroup.map(r => r.sessionId.slice(-2)).join(','))
  check('★ the parked carry-over never paints twice (one row for the id)', noRec.groups.flatMap(g => g.rows).filter(r => r.sessionId === S_A1).length === 1)
  // POISON CONTROL: no focus, no carry-over — the board is the current
  // project alone (the ★ is the focus fact, nothing else).
  slot.releaseFocusedSessionConnector()
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A), liveRecord('concourse-w3', S_B1, P_B)])
  const noFocus = await build()
  check('POISON CONTROL: with no focused session nothing of A rides B\'s board', !noFocus.groups.flatMap(g => g.rows).some(r => r.workspaceDir === P_A))
  // The source seams.
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  // RE-CUT at the conc-home fold: the glyph LEADS the title now (the
  // narrow-cell truncation law moved the trailing-space side) — the needle
  // follows the landed spelling; the law (existing vocabulary, no new
  // glyph/hex, the from-name beside the title) is unmoved.
  check('the layout paints the star (the kit\'s bright spark — existing vocabulary, no new glyph, no new hex) and the home beside the title', layout.includes('{GLYPH.sparkBright}') && layout.includes('from {r.foreignProject}') && layout.includes('color={t.info}>{GLYPH.sparkBright} '))
  const contracts = read('src/components/concourse/contracts.ts')
  check('the contract carries the mark as a typed field on the row', contracts.includes('foreignProject?: string'))
  const builder = read('src/services/concourse/concourseSnapshot.ts')
  check('the builder scopes through the ONE predicate (inProject — main\'s filter) and adds the focused session as its one exception, by the slot\'s own fact', builder.includes('inProject(project, workspaceId) ? undefined : sanitizeLabel(projectDisplayName(workspaceId))') && builder.includes('slot.hasFocusedSession()') && builder.includes("if (workspace === undefined || inProject(project, workspace)) return [r]") && builder.includes("r.sessionId === focusedSessionId ? [{ ...r, foreignProject: foreignOf(workspace) ?? '' }] : []"))
  const router = read('src/components/SurfaceRouter.tsx')
  check('the strip\'s stop follows the slot alone (the router is STRIP\'s, untouched): present = hasFocusedSession() || landingInFlight()', router.includes('present: () => hasFocusedSession() || landingInFlight(),'))
  const coord = read('src/services/concourse/coordinatorBoard.ts')
  check('the coordinator hears a carried-over row as the focused chat from its own project', coord.includes('carriedFrom: row.foreignProject') && coord.includes('the focused chat, carried over from'))
  _resetSurfaceRouteForTesting()
}

// ── §3: a new focus hands it back silently ──────────────────────────────────
console.log('§3 — A NEW FOCUS HANDS IT BACK SILENTLY: focusing a session of the current project releases the ★ row — no notice, no state change')
{
  const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A), liveRecord('concourse-w3', S_B1, P_B)])
  await switchTo(P_A)
  slot.setFocusedSessionConnector(seat.daemonSessionConnectorFor({ sessionId: S_A1, runnerId: 'concourse-w1', title: 'alpha one', projectLabel: basename(P_A), workspaceId: P_A, home: paths.getProjectDir(P_A) }))
  await switchTo(P_B)
  const carried = await build()
  check('the sequence starts with X carried onto B\'s board (★)', carried.groups.flatMap(g => g.rows).find(r => r.sessionId === S_A1)?.foreignProject === basename(P_A))
  const before = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir) }
  // The slot's beat: the board re-derives on it (the route subscribes).
  let beats = 0
  const off = slot.subscribeFocusedSessionConnector(() => {
    beats += 1
  })
  // Focus Y (= S_B1, of the current project B).
  slot.setFocusedSessionConnector(seat.daemonSessionConnectorFor({ sessionId: S_B1, runnerId: 'concourse-w3', title: 'beta one', projectLabel: basename(P_B), workspaceId: P_B, home: paths.getProjectDir(P_B) }))
  off()
  check('the slot pulsed once for the new focus (the beat the route rebuilds on)', beats === 1, String(beats))
  const handedBack = await build()
  const flat = handedBack.groups.flatMap(g => g.rows)
  check('X left B\'s board — handed back to its own project', !flat.some(r => r.sessionId === S_A1), flat.map(r => r.sessionId.slice(-2)).join(','))
  check('Y is a plain row of the current project (no ★ anywhere on the board now)', flat.find(r => r.sessionId === S_B1)?.foreignProject === undefined && flat.every(r => r.foreignProject === undefined))
  check('SILENT: no notice — the groups are the standard groups only (the elsewhere door included, law 4), no NEEDS YOU row names X, no rail entry names X', handedBack.groups.every(g => ['attached', 'needs-you', 'stalled', 'ready-to-review', 'working', 'queued', 'starting', 'paused', 'stopped', 'elsewhere', 'parked'].includes(g.id)) && !handedBack.needsYou.some(o => o.sessionId === S_A1) && handedBack.counts.needsYou === 0)
  check('SILENT: no obligation minted, no record byte moved (the hop\'s blur is the daemon\'s only moving fact, and only on the real hop)', treeBytes(crewDir) === before.crew && treeBytes(recordsDir) === before.daemon)
  check('X\'s state is unchanged: still running, still not paused, not parked, not focused-stamped by anything here', (() => {
    const w = supervisor.readSessionWorkers(recordsDir)['concourse-w1']
    return w?.endedAt === undefined && w?.pausedAt === undefined && w?.stoppedAt === undefined && w?.focusedAt === undefined
  })())
  await switchTo(P_A)
  const backHome = await build()
  const xHome = backHome.groups.flatMap(g => g.rows).find(r => r.sessionId === S_A1)
  check('back in A, X is a normal running row of ITS project (working, no mark) — exactly what it was', xHome?.state === 'working' && xHome.foreignProject === undefined)
  check('Y (focused, of B) is now the ★ row on A\'s board — the same law in the other direction', backHome.groups.flatMap(g => g.rows).find(r => r.sessionId === S_B1)?.foreignProject === basename(P_B))
  slot.releaseFocusedSessionConnector()
  // The source seams: the route rebuilds on the slot's beat; the only daemon
  // fact a focus change moves is the hop's own focus/blur, at the connector.
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check('the route rebuilds the board on the focused slot\'s beat', route.includes('const unsubSlot = subscribeFocusedSessionConnector(() => rebuild())') && route.includes('unsubSlot()'))
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  check('the blur is the connector\'s own detach verb (LAUNCHAUTH\'s), spoken once; no board surface issues a focus or blur op of its own', (connector.match(/seatVerb\('blur', this\.record\.sessionId\)/g) ?? []).length === 1 && !read('src/components/concourse/ConcourseRoute.tsx').includes("action: 'blur'") && !read('src/components/concourse/ConcourseScreen.tsx').includes("action: 'blur'") && !read('src/services/concourse/concourseSnapshot.ts').includes("action: 'blur'"))
  check('the builder mints nothing on a focus change (the snapshot is a read: no upsert, no resolve, no rpc)', !read('src/services/concourse/concourseSnapshot.ts').includes('upsertObligation') && !read('src/services/concourse/concourseSnapshot.ts').includes('daemonControlRpc'))
}

// ── §4: the running-count line, a door ──────────────────────────────────────
console.log('§4 — THE RUNNING-COUNT LINE, A DOOR: one line per other project with activity, its own group before PARKED, ↵ = the picker\'s own switch')
{
  const { projectActivity, elsewhereLine, ELSEWHERE_CAP, isRunningState, runningByProjectKey } = await import('../../src/services/concourse/projectActivity.ts')
  const { upsertObligation, resolveObligation } = await import('../../src/services/crew/obligations.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
  const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
  const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
  const P_C = join(SCRATCH, 'proj-gamma')
  const P_D = join(SCRATCH, 'proj-delta')
  const P_E = join(SCRATCH, 'proj-epsilon')
  const P_F = join(SCRATCH, 'proj-foxtrot')
  const S_A3 = sid('a3')
  const S_B2 = sid('b2')
  const S_C1 = sid('c1')
  const S_C2 = sid('c2')
  const S_D1 = sid('d1')
  const S_E1 = sid('e1')
  const S_E2 = sid('e2')
  const S_F1 = sid('f1')
  for (const [p, s] of [[P_A, S_A3], [P_B, S_B2], [P_C, S_C1], [P_C, S_C2], [P_D, S_D1], [P_E, S_E1], [P_E, S_E2], [P_F, S_F1]] as const) seedChat(p, s, `words ${s.slice(-2)}`, 5 * 60_000)
  // A (current): two live + one parked chat. B: one working + one finished
  // (settled after its last delivery). C: one working + one waiting on an
  // ask (alive). D: paused only (no activity). E: one working + one
  // stopped. F: absent for now.
  const roster = (): ConcourseWorkerRecordV1[] => [
    liveRecord('concourse-w1', S_A1, P_A),
    liveRecord('concourse-w2', S_A2, P_A),
    liveRecord('concourse-w3', S_B1, P_B),
    liveRecord('concourse-w4', S_B2, P_B, { lastDeliveryAt: NOW - 2000, lastTurnSettledAt: NOW - 1000 }),
    liveRecord('concourse-w5', S_C1, P_C),
    liveRecord('concourse-w6', S_C2, P_C),
    liveRecord('concourse-w7', S_D1, P_D, { pausedAt: NOW - 1000, pausedBy: 'operator' }),
    liveRecord('concourse-w8', S_E1, P_E),
    liveRecord('concourse-w9', sid('99'), P_E, { stoppedAt: NOW - 1000, stoppedBy: 'operator' }),
  ]
  seedWorkers(roster())
  const ask = await upsertObligation({ ref: 'q:c2', sessionId: S_C2, question: 'may I push?', owner: 'operator', scope: 'switchboard', dir: crewDir })
  slot.releaseFocusedSessionConnector()
  await switchTo(P_A)
  const snap = await build()
  const ids = snap.groups.map(g => g.id)
  const group = snap.groups.find(g => g.id === 'elsewhere')
  check('the OTHER PROJECTS group exists — after every live group of the current project and BEFORE parked (pinned: before)', group !== undefined && ids.indexOf('working') !== -1 && ids.indexOf('elsewhere') > ids.indexOf('working') && ids.includes('parked') && ids.indexOf('elsewhere') !== -1 && ids.indexOf('elsewhere') < ids.indexOf('parked') && ids[ids.length - 1] === 'parked', ids.join(','))
  const rows = group?.rows ?? []
  check('the counts per project from the daemon\'s roster + the obligations store: B = 2 running · 1 finished; C = 2 running · 1 needs you (alive and waiting counts as running); E = 1 running (the stopped one does not count)', (snap.elsewhere ?? []).map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).sort().join(' ') === ['proj-beta:2/0/1', 'proj-epsilon:1/0/0', 'proj-gamma:2/1/0'].join(' '), (snap.elsewhere ?? []).map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).join(' '))
  check('a project with a paused session only has NO line (no activity); the CURRENT project never has a line', !(snap.elsewhere ?? []).some(p => p.name === 'proj-delta' || p.name === 'proj-alpha') && !rows.some(r => r.projectLabel === 'proj-delta' || r.projectLabel === 'proj-alpha'))
  check('the lines are painted in NAME order, not count order (content-keyed; a count change never re-sorts)', rows.map(r => r.projectLabel).join(',') === 'proj-beta,proj-epsilon,proj-gamma', rows.map(r => r.projectLabel).join(','))
  check('the list behind the group is most-active-first (the bound picks by activity)', (snap.elsewhere ?? []).map(p => p.name).join(',') === 'proj-beta,proj-gamma,proj-epsilon')
  check('each line reads the board\'s compact grammar with the door in its NOW cell', rows.map(r => `${r.title} | ${r.nowLabel}`).join(' ; ') === '2 running in proj-beta · 1 finished | switch to see them ; 1 running in proj-epsilon | switch to see them ; 2 running in proj-gamma · 1 needs you | switch to see them', rows.map(r => `${r.title} | ${r.nowLabel}`).join(' ; '))
  check('each line is a DOOR row keyed by the project\'s catalog key, targeting the project\'s folder, with its counts on the door', rows.every(r => r.state === 'elsewhere' && r.sessionId === `project:${r.door?.kind === 'switch-project' ? getProjectDir(r.door.dir) : ''}` && r.workspaceDir === undefined && r.seats === null) && rows.find(r => r.projectLabel === 'proj-beta')?.door?.kind === 'switch-project' && (rows.find(r => r.projectLabel === 'proj-beta')?.door as { dir?: string }).dir === P_B)
  check('no door row carries a workspace or a transcript — nothing subscribes, nothing mirrors, nothing runs', rows.every(r => r.workspaceDir === undefined && r.transcriptPath === undefined && r.ownerLabel === null))
  check('the whole board still holds the invariant: A\'s two live rows, A\'s parked chat, three doors — nothing of B/C/D/E as a row', snap.groups.flatMap(g => g.rows).filter(r => r.door === undefined).every(r => r.workspaceDir === P_A) && snap.groups.find(g => g.id === 'parked')?.rows.map(r => r.sessionId).join(',') === S_A3)
  check(`the bound is ${ELSEWHERE_CAP} lines (ELSEWHERE_CAP) — three projects fit, no "+more" row`, ELSEWHERE_CAP === 3 && !rows.some(r => r.door?.kind === 'pick-project'))
  // A fourth active project: the least active folds into an honest "+1
  // more" door (a tie on activity breaks by name — epsilon stays, foxtrot folds).
  seedWorkers([...roster(), liveRecord('concourse-w10', S_F1, P_F)])
  const four = await build()
  const fourRows = four.groups.find(g => g.id === 'elsewhere')?.rows ?? []
  check('four active projects: three lines by activity (B, C, E — the tie E/F breaks by name) painted in name order, then "+1 more"', fourRows.map(r => r.projectLabel).join(',') === 'proj-beta,proj-epsilon,proj-gamma,—' && fourRows[3]?.door?.kind === 'pick-project' && (fourRows[3]?.door as { more?: number }).more === 1 && fourRows[3]?.title === '+1 more project with activity' && fourRows[3]?.nowLabel === '⌃g picks one' && (four.elsewhere?.length ?? 0) === 4, fourRows.map(r => r.title).join(' ; '))
  // THE CALM LAW: a count moves, the row keeps its id and its place.
  seedWorkers([...roster(), liveRecord('concourse-w10', S_F1, P_F), liveRecord('concourse-w11', S_E2, P_E)])
  const moved = await build()
  const movedRows = moved.groups.find(g => g.id === 'elsewhere')?.rows ?? []
  check('a count change repaints the line in place: same id, same position, new words (E: 1 → 2 running)', movedRows.map(r => r.sessionId).join(',') === fourRows.map(r => r.sessionId).join(',') && movedRows[1]?.title === '2 running in proj-epsilon' && fourRows[1]?.title === '1 running in proj-epsilon')
  // THE ★ EXCLUSION: the carried-over focused session is on the board
  // already — its project's line counts what you do NOT see.
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  slot.setFocusedSessionConnector(seat.daemonSessionConnectorFor({ sessionId: S_B1, runnerId: 'concourse-w3', title: 'beta one', projectLabel: basename(P_B), workspaceId: P_B, home: paths.getProjectDir(P_B) }))
  const withStar = await build()
  const bLine = withStar.groups.find(g => g.id === 'elsewhere')?.rows.find(r => r.projectLabel === 'proj-beta')
  check('with B\'s session focused (★ on A\'s board), B\'s line counts the rest: "1 running in proj-beta · 1 finished"', bLine?.title === '1 running in proj-beta · 1 finished' && withStar.groups.flatMap(g => g.rows).find(r => r.sessionId === S_B1)?.foreignProject === basename(P_B), bLine?.title)
  slot.releaseFocusedSessionConnector()
  // The pure owner and its grammar.
  const current = projectIdentity(P_A)
  const pure = projectActivity(
    [
      { sessionId: 'x1', state: 'working', workspaceDir: P_B },
      { sessionId: 'x2', state: 'needs-you', workspaceDir: P_B },
      { sessionId: 'x3', state: 'needs-you', workspaceDir: P_C },
      { sessionId: 'x4', state: 'paused', workspaceDir: P_D },
      { sessionId: 'x5', state: 'working', workspaceDir: P_A },
      { sessionId: 'x6', state: 'working', workspaceDir: P_E },
    ],
    { current, excludeSessionId: 'x6', aliveOf: id => id !== 'x3' },
  )
  check('the pure fold: groups by the catalog key, skips the current project and the excluded id, counts a live waiting session as running and a crashed one only as needs-you, drops paused-only projects', pure.map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).join(' ') === 'proj-beta:2/1/0 proj-gamma:0/1/0', pure.map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).join(' '))
  check('the ONE running predicate', isRunningState('working', false) && isRunningState('ready-to-review', false) && isRunningState('attached', false) && isRunningState('needs-you', true) && !isRunningState('needs-you', false) && !isRunningState('paused', true) && !isRunningState('stopped', true) && !isRunningState('starting', false) && !isRunningState('parked', true))
  const line = (running: number, needsYou: number, finished: number): string => elsewhereLine({ dir: P_B, key: 'k', name: 'foo', running, needsYou, finished })
  check('the line grammar: running leads; needs-you and finished follow only when non-zero; a project with no runner leads with what it has', line(3, 0, 0) === '3 running in foo' && line(2, 1, 1) === '2 running in foo · 1 needs you · 1 finished' && line(0, 2, 0) === '2 need you in foo' && line(0, 0, 1) === '1 finished in foo' && line(0, 1, 1) === '1 finished in foo · 1 needs you')
  // The face's read shares the predicate: what runs per key (asks come from
  // the async store and stay the board's).
  const face = await runningByProjectKey(recordsDir)
  check('the face\'s sync read answers the same running counts per key (B 2 · C 2 · E 2 · F 1; A 2; D none)', face.get(getProjectDir(P_B)) === 2 && face.get(getProjectDir(P_C)) === 2 && face.get(getProjectDir(P_E)) === 2 && face.get(getProjectDir(P_F)) === 1 && face.get(getProjectDir(P_A)) === 2 && face.get(getProjectDir(P_D)) === undefined, [...face.entries()].map(([k, v]) => `${basename(k)}=${v}`).join(','))
  await resolveObligation(ask.obligationId, { kind: 'withdrawn', by: 'prover', scope: 'switchboard', dir: crewDir })
  // The source seams: the door rides the picker's own path; nothing else
  // switches; the calm law holds at the tile's own predicate.
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const enterAt = screen.indexOf('const enterSession = (sessionId: string, opts: { pointer?: boolean } = {}): void => {')
  const enterBody = screen.slice(enterAt, screen.indexOf('// ── the git offer', enterAt))
  check('↵ on a door row rides pickGround — the REPO picker\'s own switch (the trust gate included); "+N more" opens the picker', enterBody.includes("if (door.kind === 'switch-project') pickGround(door.dir)") && enterBody.includes('else setGroundPickerOpen(true)') && enterBody.indexOf('const door = sessionRows.find') !== -1 && enterBody.indexOf('const door = sessionRows.find') < enterBody.indexOf('callbacks.enterSession(sessionId)'))
  check('the picker and the door share ONE apply (applyGround → setDraftSeed({ projectDir })); no second switcher exists in the screen', (screen.match(/callbacks\.setDraftSeed\(\{ projectDir: dir \}\)/g) ?? []).length === 1 && screen.includes('onPick={dir => pickGround(dir)}') && !screen.includes('applyHarnessGround'))
  check('x on a door row closes nothing and says so', screen.includes("if (sel.door !== undefined) {") && screen.includes('nothing to close here'))
  const cell = read('src/components/concourse/LiveNowCell.tsx')
  check('the NOW cell\'s live predicate excludes door rows — no tile subscription under the tiles\' subscriber (the calm law)', cell.includes("const live = row.state === 'working' || row.state === 'needs-you' || row.state === 'starting'"))
  check('the work chip needs a workspace — a door row (none) never subscribes', screen.includes("peekSelRow.workspaceDir !== undefined && peekSelRow.state !== 'parked'"))
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the spine paints a door as the kit\'s handoff arrows in info ink (existing vocabulary), the group in info', layout.includes("elsewhere: { glyph: GLYPH.handoff, color: 'info' }") && layout.includes("id === 'working' || id === 'elsewhere'"))
  const contracts = read('src/components/concourse/contracts.ts')
  check('the contract types the door row, the group and the whole list', contracts.includes("| 'elsewhere'") && contracts.includes("| 'stopped' | 'elsewhere' | 'parked'") && contracts.includes('elsewhere?: ConcourseElsewhereV1[]') && contracts.includes("{ kind: 'switch-project'; dir: string; running: number; needsYou: number; finished: number }"))
  const builder = read('src/services/concourse/concourseSnapshot.ts')
  check('the builder pushes OTHER PROJECTS after STOPPED and before PARKED, from the one owner, name-ordered, the ★ excluded', builder.indexOf("groups.push({ id: 'stopped', label: 'STOPPED'") !== -1 && builder.indexOf("groups.push({ id: 'elsewhere', label: 'OTHER PROJECTS'") > builder.indexOf("groups.push({ id: 'stopped', label: 'STOPPED'") && builder.indexOf("groups.push({ id: 'elsewhere', label: 'OTHER PROJECTS'") !== -1 && builder.indexOf("groups.push({ id: 'elsewhere', label: 'OTHER PROJECTS'") < builder.indexOf("groups.push({ id: 'parked', label: 'PARKED'") && builder.includes("import { ELSEWHERE_CAP, elsewhereLine, projectActivity } from './projectActivity.js'") && builder.includes('.slice(0, ELSEWHERE_CAP).sort((a, b) => a.name.localeCompare(b.name))') && builder.includes('excludeSessionId: focusedSessionId,'))
  const coord = read('src/services/concourse/coordinatorBoard.ts')
  check('the coordinator never hears a door as a session; it hears the other projects as their own list', coord.includes('if (row.door !== undefined) continue') && coord.includes('...(elsewhere.length > 0 ? { elsewhere } : {})'))
}

// ── §5: the cross-project ping, a door ──────────────────────────────────────
console.log('§5 — THE CROSS-PROJECT PING, A DOOR: an ask or a finish in another project rows on the rail as "switch to foo", the ⚑ counts it, the engine rings once, ↵ = switch + open')
{
  const pings = await import('../../src/services/concourse/crossProjectPings.ts')
  const { sweepCrossProjectFinishes, finishedStampOf, startCrossProjectFinishWatch, CROSS_PROJECT_FINISHED_REF, isCrossProjectFinishedRef } = pings
  const { upsertObligation, openObligations, resolveObligation } = await import('../../src/services/crew/obligations.ts')
  const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')
  const { createPingEngine, pingSliceOf } = await import('../../src/services/pings/pingEngine.ts')
  const { obligationFacts } = await import('../../src/services/crew/obligationsBridge.ts')
  const { foldAttention, emptyAttentionState, bucketItems } = await import('../../src/services/attention/contracts.ts')
  const { railTailParts } = await import('../../src/components/concourse/NeedsYouRail.tsx')
  const S_B2 = sid('b2')
  slot.releaseFocusedSessionConnector()
  await switchTo(P_A)
  const rosterOf = (b2: Partial<ConcourseWorkerRecordV1>, a1: Partial<ConcourseWorkerRecordV1> = {}): ConcourseWorkerRecordV1[] => [
    liveRecord('concourse-w1', S_A1, P_A, a1),
    liveRecord('concourse-w3', S_B1, P_B),
    liveRecord('concourse-w4', S_B2, P_B, { lastDeliveryAt: NOW - 2000, lastTurnSettledAt: NOW - 1000, ...b2 }),
  ]
  seedWorkers(rosterOf({}))
  // PINGS's engine, armed BEFORE the events (a fact stamped after the arm
  // rings; one ring per subject, ever).
  let clock = Date.now() - 1000
  let rings = 0
  const engine = createPingEngine({ ringBell: () => (rings += 1), bellEnabled: () => true, nowMs: () => clock })
  const attentionOf = async (): Promise<ReturnType<typeof foldAttention>> =>
    foldAttention(emptyAttentionState(), obligationFacts(await openObligations({ scope: 'switchboard', dir: crewDir }), 'operator', Date.now()))
  engine.observe(pingSliceOf(await attentionOf()))
  check('before any need the engine is quiet', rings === 0)
  // (a) an ASK raised by a session in B while the view is A.
  const ask = await upsertObligation({ ref: 'q:b1', sessionId: S_B1, question: 'shall I merge?', owner: 'operator', scope: 'switchboard', dir: crewDir })
  const local = await upsertObligation({ ref: 'q:a1', sessionId: S_A1, question: 'which branch?', owner: 'operator', scope: 'switchboard', dir: crewDir })
  const snap = await build()
  const foreignRow = snap.needsYou.find(o => o.obligationId === ask.obligationId)
  const localRow = snap.needsYou.find(o => o.obligationId === local.obligationId)
  check('a foreign ask rows as "switch to <name> · needs you", keeps its question, names ITS project and carries the door', foreignRow?.title === `switch to ${basename(P_B)} · needs you` && foreignRow.question === 'shall I merge?' && foreignRow.projectLabel === basename(P_B) && foreignRow.foreignProject?.dir === P_B && foreignRow.foreignProject.name === basename(P_B), `${foreignRow?.title} | ${foreignRow?.projectLabel}`)
  check('a local ask keeps the ordinary row — its question as title, its own project, no door', localRow?.title === 'which branch?' && localRow.projectLabel === basename(P_A) && localRow.foreignProject === undefined)
  check('the rail counts both (the ⚑ counts a foreign need like any need — counts.needsYou is the whole store)', snap.counts.needsYou === 2 && snap.needsYou.length === 2)
  const state1 = await attentionOf()
  check('the attention fold holds the foreign ask in needs-you (the badge\'s own bucket)', bucketItems(state1, 'needs-you').some(i => i.subjectId === `obligation:${ask.obligationId}`))
  clock += 2000
  engine.observe(pingSliceOf(state1))
  check('PINGS rings ONCE for the two new subjects (coalesced within the window — one tap)', rings === 1, String(rings))
  clock += 5000
  engine.observe(pingSliceOf(state1))
  check('the same needs never re-ring (a store-read replay is silent)', rings === 1)
  await upsertObligation({ ref: 'q:b1', sessionId: S_B1, question: 'shall I merge? (still)', owner: 'operator', scope: 'switchboard', dir: crewDir })
  clock += 5000
  engine.observe(pingSliceOf(await attentionOf()))
  check('a re-raise (revision bump) of the foreign ask never re-rings — never a nag', rings === 1)
  const tail = railTailParts({ projectLabel: 'proj-beta', agentLabel: 'operator', ageLabel: '01m' }, 200, true)
  check('the rail\'s one affordance on a door row is "switch & open" (no separate open; dismiss stays)', tail.some(p => p.key === 'answer' && p.text.includes('switch & open')) && !tail.some(p => p.key === 'open') && tail.some(p => p.key === 'dismiss'))
  check('an ordinary row keeps "answer & resume" and "open session"', railTailParts({ projectLabel: 'x', agentLabel: 'y', ageLabel: '01m' }, 200).map(p => p.key).join(',') === 'meta,answer,open,dismiss')
  // (b) a FINISH in B: the sweep — seed-silent, once per settle, never the
  // current project, the memory moving for every session.
  const seen = new Map<string, number>()
  const deps = { records: () => Object.values(supervisor.readSessionWorkers(recordsDir)), current: () => projectIdentity(P_A), isAlive: () => true, seen }
  const first = sweepCrossProjectFinishes(deps)
  check('the first beat SEEDS silently: the standing finish in B is old news — nothing minted, the stamp remembered', first.length === 0 && seen.get(S_B2) === NOW - 1000)
  seedWorkers(rosterOf({ lastDeliveryAt: NOW + 4000, lastTurnSettledAt: NOW + 5000 }))
  const second = sweepCrossProjectFinishes(deps)
  check('a NEW finish in another project mints ONE need of the new kind: the finish-stamped ref, the door\'s target, the plain words', second.length === 1 && second[0]?.ref === `${CROSS_PROJECT_FINISHED_REF}${S_B2}:${NOW + 5000}` && second[0].sessionId === S_B2 && second[0].dir === P_B && second[0].question === `your agent in ${basename(P_B)} finished · chat b2` && isCrossProjectFinishedRef(second[0].ref), second[0]?.ref)
  check('the same finish never re-mints (once per need, never a nag)', sweepCrossProjectFinishes(deps).length === 0)
  seedWorkers(rosterOf({ lastDeliveryAt: NOW + 4000, lastTurnSettledAt: NOW + 5000 }, { lastDeliveryAt: NOW + 5500, lastTurnSettledAt: NOW + 6000 }))
  check('a finish in the CURRENT project mints nothing (it is a row in front of you) — and the memory moves', sweepCrossProjectFinishes(deps).length === 0 && seen.get(S_A1) === NOW + 6000)
  deps.current = () => projectIdentity(P_B)
  check('switching away later never pings that finish (the memory already holds it)', sweepCrossProjectFinishes(deps).length === 0)
  deps.current = () => projectIdentity(P_A)
  seedWorkers(rosterOf({ lastDeliveryAt: NOW + 7000, lastTurnSettledAt: NOW + 5000 }))
  check('a delivery after the settle is a session working again — not a finish', sweepCrossProjectFinishes(deps).length === 0)
  seedWorkers(rosterOf({ lastDeliveryAt: NOW + 7000, lastTurnSettledAt: NOW + 8000 }))
  const third = sweepCrossProjectFinishes(deps)
  check('its NEXT settle is a genuinely new finish — one new need with the new stamp', third.length === 1 && third[0]?.ref === `${CROSS_PROJECT_FINISHED_REF}${S_B2}:${NOW + 8000}`)
  seedWorkers(rosterOf({}))
  check('a session that leaves the roster leaves the memory (bounded)', (sweepCrossProjectFinishes({ ...deps, records: () => [liveRecord('concourse-w1', S_A1, P_A)] }), !seen.has(S_B2)))
  const rec = liveRecord('concourse-w4', S_B2, P_B, { lastDeliveryAt: NOW - 2000, lastTurnSettledAt: NOW - 1000 })
  check('the finish predicate: settled at/after the last delivery and alive; never paused, attached, stopped, parked, crashed, dead, or unsettled', finishedStampOf(rec, true) === NOW - 1000 && finishedStampOf(rec, false) === undefined && finishedStampOf({ ...rec, pausedAt: 1 }, true) === undefined && finishedStampOf({ ...rec, attachedAt: 1 }, true) === undefined && finishedStampOf({ ...rec, stoppedAt: 1 }, true) === undefined && finishedStampOf({ ...rec, parkedAt: 1 } as ConcourseWorkerRecordV1, true) === undefined && finishedStampOf({ ...rec, crash: { at: 1, reason: 'x', respawning: false } }, true) === undefined && finishedStampOf({ ...rec, lastDeliveryAt: NOW }, true) === undefined && finishedStampOf({ ...rec, lastTurnSettledAt: undefined }, true) === undefined)
  // The minted need through the estate: the rail, the fold, one more ring.
  const minted = await upsertObligation({ ref: second[0]!.ref, sessionId: S_B2, question: second[0]!.question, owner: 'operator', scope: 'switchboard', dir: crewDir })
  const withFinish = await build()
  const finRow = withFinish.needsYou.find(o => o.obligationId === minted.obligationId)
  check('the finished-elsewhere need rows as "switch to <name> · finished" with the door and its own words', finRow?.title === `switch to ${basename(P_B)} · finished` && finRow.foreignProject?.dir === P_B && finRow.question === `your agent in ${basename(P_B)} finished · chat b2` && finRow.ref === second[0]!.ref)
  clock += 5000
  engine.observe(pingSliceOf(await attentionOf()))
  check('the engine rings once more — a new subject (the finish), never the old ones', rings === 2, String(rings))
  // The watch's gate and its seed.
  const off = startCrossProjectFinishWatch({ enabled: () => false, recordsDir })
  check('the plain world starts no watch: nothing seeded, nothing minted', off._seenForTesting().size === 0)
  off.dispose()
  const on = startCrossProjectFinishWatch({ enabled: () => true, recordsDir, tickMs: 60_000 })
  await new Promise(r => setTimeout(r, 50))
  check('a started watch seeds on its first beat (silently) and remembers the standing stamps', on._seenForTesting().has('\u0000seeded') && on._seenForTesting().get(S_B2) === NOW - 1000)
  on.dispose()
  for (const id of [ask.obligationId, local.obligationId, minted.obligationId]) await resolveObligation(id, { kind: 'withdrawn', by: 'prover', scope: 'switchboard', dir: crewDir })
  // The source seams.
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
    // The untrusted sentence paints its key hint through keyHintLabel (the
  // host's key spelling, class-5 seams) — the needle rides the landed
  // template spelling.
  check('↵ on a foreign rail row takes the door: switch (the picker\'s own apply, trust-gated) + open; an untrusted folder opens the chat anyway and says where the view stayed', screen.includes('if (o.foreignProject !== undefined) {\n      // The door') && screen.includes('if (isPathTrusted(home.dir)) applyGround(home.dir)') && screen.includes("stays untrusted ${keyHintLabel('(⌃g trusts it)')} · opening the chat anyway") && screen.indexOf('takeObligationDoor(o)') !== -1 && screen.indexOf('takeObligationDoor(o)') < screen.indexOf('if (reducedStage) {\n      // No composer'))
  check('o and the rail\'s open chip take the same door', screen.includes('if (o) openObligationOrDoor(o.obligationId)') && screen.includes('openObligation: id => openObligationOrDoor(id),'))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  // The obligation-door entry is a 'settled' continuation leg since the
  // entry gate (SWIFT C1): the attach call carries entry: 'settled' — the
  // needle rides the landed call spelling.
  check('the route settles the finished kind on its door (resolved, by the operator) and leaves the ask kinds open', route.includes('if (isCrossProjectFinishedRef(row.ref)) {') && route.indexOf("attachAndEnter(row.sessionId, 'board:open', { fullChat: true, entry: 'settled' })\n          // THE CROSS-PROJECT FINISHED PING") !== -1 && route.indexOf('isCrossProjectFinishedRef(row.ref)') > route.indexOf("attachAndEnter(row.sessionId, 'board:open', { fullChat: true, entry: 'settled' })\n          // THE CROSS-PROJECT FINISHED PING") && route.includes("kind: 'resolved', by: 'operator', scope: 'switchboard'"))
  const signals = read('src/hooks/useObligationSignals.ts')
  check('the host toast names the finished kind (the detail preview off included)', signals.includes("title: isCrossProjectFinishedRef(o.ref) ? 'an agent finished in another project — switch to see it' : 'a session needs you'"))
  const service = read('src/services/concourse/crossProjectPings.ts')
  check('the mint rides the obligations owner\'s existing door (upsertObligation, switchboard scope, the operator) — no second store, no fork of the engine', service.includes("await upsertObligation({ ref: m.ref, sessionId: m.sessionId, question: m.question, owner: 'operator', scope: 'switchboard' })") && !service.includes('createPingEngine') && !service.includes('ringBell'))
  const hook = read('src/hooks/useCrossProjectFinishPings.ts')
  check('the watch mounts in the visible process beside the ping engine and is gated by the strip\'s plain-world fact', hook.includes('startCrossProjectFinishWatch({ enabled: () => !chatOnlyBoot() })') && read('src/screens/REPL.tsx').includes('usePingEngine();\n  useCrossProjectFinishPings();'))
  const engineSrc = read('src/services/pings/pingEngine.ts')
  check('PINGS\'s engine is untouched by this lane (its policy stays its own)', engineSrc.includes('RE-RING NEVER') && !engineSrc.includes('cross-project'))
  const frame = read('src/components/MercuryFrame.tsx')
  check('the ⚑ badge counts the attention view\'s needs-you bucket — every open need, whatever its project', frame.includes('attentionView.needsYou > 0') && frame.includes('needsYouCount(attentionView.needsYou)') && read('src/utils/needsYouCount.ts').includes('need you'))
}

// ── §6: the indicator on the boot face ──────────────────────────────────────
console.log('§6 — THE INDICATOR ON THE BOOT FACE: the Projects rows read the same running count from the same owner; a row without one composes its old bytes')
{
  const core = await import('../../assets/splash/splash-core.mjs')
  const c = core.createSplashCore({ nocolor: false, truecolor: true })
  const ESC = String.fromCharCode(27)
  const strip = (s: string): string => s.split(ESC).map((seg, i) => (i === 0 ? seg : seg.replace(/^\[[0-9;]*m/, ""))).join("")
  const vis = (s: string): number => c.vis(s) as number
  // RE-HOMED (the operator's merge): the card's Projects
  // row folded into the merged 'Sessions · Projects' door — LAW 6's
  // indicator now lives on the MERGED screen's project rows (the same
  // count, the same owner, handed through the resume mount's props). The
  // card composes NO project row at all.
  const recut = core.assembleCardRows({ cwdBase: 'here', continueTarget: null, menuAvailable: true, concourse: { ctx: 'x' } }) as Array<{ key: string; ctx: string }>
  check('the card composes NO standalone project row (the merged door carries the estate)', !recut.some(r => r.key === 'project') && recut.some(r => r.key === 'sessions'))
  const { resumeProjectEntryOf } = await import('../../src/components/BootResumeScreen.js')
  const mergedRow = resumeProjectEntryOf({ dir: '/p/foo', base: 'foo', ageMs: 5 * 60_000, sessionId: 'a', transcriptPath: null, firstChatAt: 1, firstSessionId: 'a', running: 3 })
  check('the merged screen\'s project row wears "5m · 3 running"', mergedRow.valueLabel === '5m · 3 running', mergedRow.valueLabel)
  const mergedPlain = resumeProjectEntryOf({ dir: '/p/foo', base: 'foo', ageMs: 5 * 60_000, sessionId: 'a', transcriptPath: null, firstChatAt: 1, firstSessionId: 'a' })
  check('no count ⇒ the age alone (a row without one says nothing of it)', mergedPlain.valueLabel === '5m', mergedPlain.valueLabel)
  const rowsNoCount = [{ base: 'foo', ageMs: 60_000, dirShown: '~/p/foo' }, { base: 'bar', ageMs: 120_000, dirShown: '~/p/bar' }]
  const before = c.composeProjects(rowsNoCount, 0, 100) as { lines: string[] }
  const zero = c.composeProjects(rowsNoCount.map(r => ({ ...r, running: 0 })), 0, 100) as { lines: string[] }
  check('the picker composes BYTE-IDENTICAL lines for rows without a count and rows with zero (the launcher seam is untouched)', before.lines.join('\n') === zero.lines.join('\n'))
  const withCount = c.composeProjects([{ ...rowsNoCount[0]!, running: 3 }, rowsNoCount[1]!], 0, 100) as { lines: string[]; rowLines: number[] }
  const fooLine = withCount.lines[withCount.rowLines[0]!]!
  const barLine = withCount.lines[withCount.rowLines[1]!]!
  check('the picker paints "3 running" on the row that runs, right before its age, and nothing on the other', strip(fooLine).includes('3 running') && /3 running\s+1m/.test(strip(fooLine)) && !strip(barLine).includes('running'))
  check('the note never widens the row past the box (the line keeps the box width)', vis(fooLine) === vis(before.lines[withCount.rowLines[0]!]!) && vis(fooLine) === vis(barLine))
  check('the note wears the accent (never the faint ink) and closes with the reset before the faint age', fooLine.includes('3 running' + c.R) && !fooLine.includes(c.hexFg(c.FAINT, c.T256.faint) + '3 running') && fooLine.indexOf('3 running') < fooLine.indexOf(c.hexFg(c.FAINT, c.T256.faint) + '1m'))
  const face = read('src/components/BootSplashScreen.tsx')
  check('the face reads the SAME owner (runningByProjectKey) keyed by the catalog\'s project key, once at mount', face.includes("import('../services/concourse/projectActivity.js')") && face.includes('const counts = await m.runningByProjectKey();') && face.includes('runningByKey.get(getProjectDir(dir))'))
  // RE-HOMED: the face's ONE count consumer is the merged
  // screen's projects prop now (the picker view retired with its row).
  check('the face passes the count into the merged screen — only when non-zero', face.includes('return running > 0 ? { ...p, running } : p;') && face.includes('openProject={openProject}'))
  check('ABSENT IN THE PLAIN WORLD: the read is gated on the strip\'s own fact (chatOnlyBoot) — no third flag', face.includes('if (chatOnlyBoot()) return;') && face.includes('chatOnlyBoot,\n  enterConcourse,'))
  const owner = read('src/services/concourse/projectActivity.ts')
  check('the owner\'s face read shares the ONE running predicate with the board\'s lines', owner.includes('if (!isRunningState(state, alive)) continue') && owner.includes('if (isRunningState(row.state, opts.aliveOf?.(row.sessionId) ?? true)) entry.running += 1'))
}

// ── §7: the annex ───────────────────────────────────────────────────────────
console.log('§7 — THE ANNEX: Projects-↵ hops into a wordless live newborn through the card')
{
  const { workedInProjects, catalogFirstChat, _resetProjectCatalogForTesting } = await import('../../src/utils/bootCardFacts.ts')
  // The card-aware hop: the card names the first session; the row carries it.
  const P_G = join(SCRATCH, 'proj-golf')
  const S_G0 = sid('g0')
  mkdirSync(P_G, { recursive: true })
  _resetProjectCatalogForTesting()
  catalogFirstChat(P_G, S_G0)
  const rowG = workedInProjects().find(r => r.dir === P_G)
  check('a catalogued folder with a wordless first chat lists with the card\'s firstSessionId and no resumable transcript', rowG !== undefined && rowG.sessionId === null && rowG.transcriptPath === null && rowG.firstSessionId === S_G0, JSON.stringify(rowG))
  check('a card-less project carries no firstSessionId', workedInProjects().find(r => r.dir === P_A)?.firstSessionId === null)
  seedWorkers([liveRecord('concourse-w1', S_G0, P_G)])
  check('the gate the face reads: the first session is owned by a LIVE worker (a hop, not a birth)', supervisor.sessionOwnedByLiveWorker(S_G0, recordsDir) === 'concourse-w1')
  seedWorkers([])
  check('with no live worker the gate answers null (the birth arm stands, as before)', supervisor.sessionOwnedByLiveWorker(S_G0, recordsDir) === null)
  const face = read('src/components/BootSplashScreen.tsx')
  const openAt = face.indexOf('const openProject = (p: BootProjectFact): AsyncListNote => {')
  const openBody = face.slice(openAt, face.indexOf('// ── the ORIGINAL rows', openAt))
  check('Projects-↵: the resumable arm first, then the card-aware hop (firstSessionId owned by a live worker → hopIntoBoardSession), then the birth', openBody.indexOf('if (p.sessionId !== null) {') !== -1 && openBody.indexOf('if (p.sessionId !== null) {') < openBody.indexOf('sessionOwnedByLiveWorker(p.firstSessionId) !== null') && openBody.indexOf('sessionOwnedByLiveWorker(p.firstSessionId) !== null') !== -1 && openBody.indexOf('sessionOwnedByLiveWorker(p.firstSessionId) !== null') < openBody.indexOf('hop.hopIntoBoardSession(p.firstSessionId)') && openBody.indexOf('hop.hopIntoBoardSession(p.firstSessionId)') !== -1 && openBody.indexOf('hop.hopIntoBoardSession(p.firstSessionId)') < openBody.indexOf('bornSession({ workspaceDir: p.dir })'))
  check('the hop reads the daemon\'s oracle through a dynamic import (the concourse subsystem stays off the face\'s static boot graph)', openBody.includes("(await import('../daemon/concourseSupervisor.js')).sessionOwnedByLiveWorker(p.firstSessionId)") && !face.includes("from '../daemon/concourseSupervisor.js'"))
  const facts = read('src/utils/bootCardFacts.ts')
  check('the fact carries firstSessionId from the card (empty ⇒ null)', facts.includes('firstSessionId: string | null') && facts.includes("firstSessionId: e.facts.card !== null && e.facts.card.firstSessionId.length > 0 ? e.facts.card.firstSessionId : null,"))
}

// ── §8: session-aware naming (L16) ──────────────────────────────────────────
console.log('§8 — SESSION-AWARE NAMING: three stages, one owner; the mint once at turn two; a typed name survives; never a worker id, in any world')
{
  const { sessionTitleOf, newSessionTitle, isWorkerIdTitle, shouldMintTitle } = await import('../../src/services/concourse/sessionNaming.ts')
  const { transcriptHeadFacts } = await import('../../src/services/concourse/sessionTitleMint.ts')
  const manifest = await import('../../src/components/concourse/controlManifest.ts')
  const { setConcourseSessionTitle } = supervisor
  check('stage 1: an untitled, wordless session is the FACT — "new session · <project> · ready" — never an invented name', sessionTitleOf({ workspaceId: P_A }, () => null) === `new session · ${basename(P_A)} · ready` && newSessionTitle(P_A) === `new session · ${basename(P_A)} · ready`)
  check('stage 2: the first words name it the moment they exist (zero cost — the board\'s own brief)', sessionTitleOf({ workspaceId: P_A }, () => 'fix the auth tests') === 'fix the auth tests')
  check('stage 3 / the operator: a stored title outranks the words', sessionTitleOf({ title: 'Fix flaky auth tests', workspaceId: P_A }, () => 'fix the auth tests') === 'Fix flaky auth tests')
  check('the poison detector: the worker short is never a title, and the owner cannot even see one (it is not an input)', isWorkerIdTitle('concourse-w3') && !isWorkerIdTitle('fix the auth tests') && !isWorkerIdTitle(sessionTitleOf({ workspaceId: P_A }, () => null)))
  check('the mint gate: at turn ONE never (the poison); at turn two once; never twice (the stamp); never over a name; never on an ended record', !shouldMintTitle({}, 1) && shouldMintTitle({}, 2) && !shouldMintTitle({ titleMintedAt: 1 }, 5) && !shouldMintTitle({ title: 'named' }, 5) && !shouldMintTitle({ endedAt: 1 }, 5))
  // The turn counter reads the transcript's own records, bounded.
  const S_T1 = sid('t1')
  const S_T2 = sid('t2')
  seedChat(P_A, S_T1, 'one question', 60_000)
  const oneTurn = transcriptHeadFacts({ sessionId: S_T1, workspaceId: P_A })
  check('one reply on record reads ONE assistant turn — the mint stays shut', oneTurn.assistantTurns === 1 && !shouldMintTitle({}, oneTurn.assistantTurns))
  {
    const file = workerTranscriptPath({ sessionId: S_T2, workspaceId: P_A })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, encodeSeedTranscript([...transcriptRows(P_A, S_T2, 'first ask'), ...transcriptRows(P_A, S_T2, 'second ask')] as never, S_T2))
  }
  const twoTurns = transcriptHeadFacts({ sessionId: S_T2, workspaceId: P_A })
  check('two replies read TWO turns and a description carrying the chat\'s own words', twoTurns.assistantTurns >= 2 && twoTurns.description.includes('first ask') && shouldMintTitle({}, twoTurns.assistantTurns))
  // The record's ONE writer, executed over the scratch records dir.
  rmSync(supervisor.concourseDeltaPath(recordsDir), { force: true })
  seedWorkers([liveRecord('concourse-w1', S_T2, P_A, { title: undefined })])
  const recOf = (): ConcourseWorkerRecordV1 | undefined => supervisor.readSessionWorkers(recordsDir)['concourse-w1']
  check('a minted title fills the empty slot, stamps titleMintedAt once, and publishes (the delta repaints every board)', setConcourseSessionTitle(S_T2, '  Fix   the auth tests  ', 'title-mint', 'minted', recordsDir).outcome === 'applied' && recOf()?.title === 'Fix the auth tests' && recOf()?.titleSource === 'minted' && typeof recOf()?.titleMintedAt === 'number' && existsSync(supervisor.concourseDeltaPath(recordsDir)))
  seedWorkers([liveRecord('concourse-w1', S_T2, P_A, { title: undefined, titleMintedAt: 5 })])
  check('the mint never runs twice: a second minted write is a NOOP even with the slot empty again', setConcourseSessionTitle(S_T2, 'Another', 'title-mint', 'minted', recordsDir).outcome === 'noop' && (recOf()?.title ?? '') === '')
  seedWorkers([liveRecord('concourse-w1', S_T2, P_A, { title: 'My name' })])
  check('a minted word never covers a standing name', setConcourseSessionTitle(S_T2, 'Minted words', 'title-mint', 'minted', recordsDir).outcome === 'noop' && recOf()?.title === 'My name')
  check('the operator\'s word always lands, and a later mint bounces off it', setConcourseSessionTitle(S_T2, 'Operator name', 'operator', 'operator', recordsDir).outcome === 'applied' && recOf()?.title === 'Operator name' && recOf()?.titleSource === 'operator' && setConcourseSessionTitle(S_T2, 'Minted again', 'title-mint', 'minted', recordsDir).outcome === 'noop' && recOf()?.title === 'Operator name')
  check('an empty operator title and an unknown session are typed refusals', setConcourseSessionTitle(S_T2, '   ', 'operator', 'operator', recordsDir).outcome === 'refused' && setConcourseSessionTitle(sid('zz'), 'x', 'operator', 'operator', recordsDir).outcome === 'refused')
  // The board speaks the stages.
  const S_T3 = sid('t3')
  slot.releaseFocusedSessionConnector()
  await switchTo(P_A)
  seedWorkers([liveRecord('concourse-w2', S_T3, P_A, { title: undefined })])
  const stage1 = (await build()).groups.flatMap(g => g.rows).find(r => r.sessionId === S_T3)
  check('the board row of an untitled wordless session reads stage 1 — never concourse-wN', stage1?.title === `new session · ${basename(P_A)} · ready` && !isWorkerIdTitle(stage1?.title ?? ''), stage1?.title)
  seedChat(P_A, S_T3, 'polish the boot face', 30_000)
  const stage2 = (await build()).groups.flatMap(g => g.rows).find(r => r.sessionId === S_T3)
  check('with words on record the row reads them (stage 2)', stage2?.title === 'polish the boot face', stage2?.title)
  seedWorkers([liveRecord('concourse-w2', S_T3, P_A, { title: 'Boot face polish' })])
  const stage3 = (await build()).groups.flatMap(g => g.rows).find(r => r.sessionId === S_T3)
  check('a stored title wins everywhere the snapshot paints (stage 3)', stage3?.title === 'Boot face polish')
  // The seams.
  const builder8 = read('src/services/concourse/concourseSnapshot.ts')
  check('the builder and the peek derive through the ONE owner; the worker-short title fallback is GONE from the estate', builder8.includes('sessionTitleOf(rec, () => headBriefLabel(rec, 48))') && builder8.includes('sessionTitleOf(peekRecord, () => headBriefLabel(peekRecord, 48))') && !builder8.includes('rec.title ?? rec.runnerId') && !read('src/services/switchboard/hopIntoSession.ts').includes('rec.title ?? rec.runnerId'))
  check('the chat\'s tag reads the record title the hop derives through the owner (the --chat "concourse-w3" tag retires)', read('src/services/switchboard/hopIntoSession.ts').includes('sessionTitleOf(rec, () => headBriefLabel(rec, 48))') && read('src/components/SwitchboardTagBar.tsx').includes('s.title'))
  check('the wire carries set-title end to end: the protocol, the server\'s guard and payload, the executor\'s arm, the one writer', read('src/daemon/protocol.ts').includes("| 'set-title'") && read('src/daemon/controlServer.ts').includes("raw.action === 'set-title'") && read('src/daemon/controlServer.ts').includes('title: raw.title.slice(0, 200)') && read('src/daemon/main.ts').includes("if (action === 'set-title') {") && read('src/daemon/main.ts').includes('settle(setConcourseSessionTitle('))
  check('the stamp has ONE writer: titleMintedAt is assigned in the supervisor verb alone (a failed mint leaves no stamp anywhere)', (read('src/daemon/concourseSupervisor.ts').match(/titleMintedAt = /g) ?? []).length === 1 && !read('src/services/concourse/sessionTitleMint.ts').includes('titleMintedAt ='))
  check('/title is registered and rides the op as the operator\'s word; no words ⇒ the same small call, explicitly asked', read('src/commands.ts').includes("import title from './commands/title/index.js'") && read('src/commands/title/title.ts').includes("action: 'set-title'") && read('src/commands/title/title.ts').includes("titleSource: 'operator'") && read('src/commands/title/title.ts').includes('generateSessionTitle('))
  check('the board\'s rename: the r key and context on the full stage only; the route writes the operator\'s word; the legend prints r exactly with the composer doors', read('src/components/concourse/ConcourseScreen.tsx').includes("kind: 'rename'") && read('src/components/concourse/ConcourseScreen.tsx').includes("input === 'r' && !key.ctrl && !key.meta && !verbsYield && !reducedStage") && read('src/components/concourse/ConcourseRoute.tsx').includes("action: 'set-title', sessionId, by: 'operator', title, titleSource: 'operator'") && manifest.regionKeysFor('list', { newSession: false }).every(k => k.keys !== 'r') && manifest.regionKeysFor('list', { newSession: true }).some(k => k.keys === 'r'))
  check('the mint rides the estate\'s existing small call and mounts beside the ping engine in the visible process, in every world', read('src/services/concourse/sessionTitleMint.ts').includes("import('../../utils/sessionTitle.js')") && read('src/screens/REPL.tsx').includes('useSessionTitleMint();') && !read('src/hooks/useSessionTitleMint.ts').includes('chatOnlyBoot'))
}

await applyHarnessGround(null)
rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-cross-project: ALL LAWS HOLD' : `\nprove-cross-project: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
