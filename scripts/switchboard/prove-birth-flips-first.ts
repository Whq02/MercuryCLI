#!/usr/bin/env bun
// ============================================================================
//  prove-birth-flips-first — THE FIRST CHAT PAINTS AT ONCE. The boot face's
//  New Session flips the chat route BEFORE the birth answers and lands the
//  birth behind (the chat-forward boot's own shape); a refused birth hands
//  the frame back to the face with its reason on the screen-receipt seam;
//  a keyless home is born on the neutral placeholder, never refused naming
//  a family nobody chose; the resume picker hops on the log's path and
//  title, never a whole-transcript parse.
//
//  The find (the launcher-hold capture, keyless home): the face's ↵ named
//  the harness's keyless placeholder, the daemon refused it as a Claude id
//  with no credential ("model refused (no-credential:anthropic) · ask the
//  operator to run /logins anthropic…"), and the cockpit never painted —
//  and on every home the face sat on 'starting a session…' through the
//  daemon's whole handshake ladder before the chat could show.
//
//    §1 the source law: the face flips before it awaits; the refusal
//       settles the absent chat and mints the warning on the next
//       macrotask; the face subscribes to the seam and paints it; the
//       milestones record the order; the model still resolves inside the
//       door; the picker hops on path + title with no loader
//    §2 the seed, pure: a keyless registry seeds the operator's own row
//    §3 a live keyless home: an unnamed SESSION launch admits keyless on
//       the placeholder (the row reads 'no sign-in yet'); the named
//       placeholder is the same unnamed launch; a crew seat speaks the
//       two-door sentence; a NAMED Claude id keeps its own refusal
//    §4 the seam's order: a listener gone before the mint never sees it;
//       a mint with no listener queues and drains to the next subscriber
//    §5 THE DRIVE on the built bundle (a keyless, one-seat capture home):
//       ↵ births keyless and the cockpit paints; the milestones say
//       chat-flipped before birth-landed; back on the face a second ↵ is
//       refused (every seat is taken) and the face returns wearing the
//       receipt; the records hold exactly one session (no ghost)
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-birth-flips-first.ts
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { driveWallSeconds, driverClosed, unfiredDetail } from '../lib/ptydriveReport.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const ordered = (src: string, ...needles: string[]): boolean => {
  let at = -1
  for (const n of needles) {
    const i = src.indexOf(n, at + 1)
    if (i === -1) return false
    at = i
  }
  return true
}
const text = (v: unknown): string => JSON.stringify(v)

// ── env hygiene BEFORE any src import (the keyless home) ─────────────────────
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'birth-flips-first-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_OAUTH_TOKEN', 'MERCURY_GEMINI_OAUTH_TOKEN',
  'MOONSHOT_API_KEY', 'MOONSHOT_TOKEN', 'HF_TOKEN', 'HF_OAUTH_TOKEN', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL',
] as const
for (const key of CREDENTIAL_KEYS) delete process.env[key]
for (const ambient of ['ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN']) delete process.env[ambient]
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
mkdirSync(join(scratch, 'daemon'), { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

section('§1 the source law — flip first, birth behind, the refusal on the seam, the picker on path + title')
{
  const face = read('src/components/BootSplashScreen.tsx')
  check('the face starts the birth through the one door with the model resolving inside it (the B3 needle stands)', face.includes('flipFirstBirth(bornSession => bornSession({ workspaceDir: getCwd() }))') && read('src/services/switchboard/bornSession.ts').includes('birthModelOf('))
  check('…both birth arms ride the one flip-first road (New Session and a project card’s fresh chat)', face.includes('flipFirstBirth(bornSession => bornSession({ workspaceDir: p.dir }))'))
  check('…flips the chat route BEFORE awaiting the birth', ordered(face, 'const birth = start(bornSession);', 'const flipped = enterRootRepl().ok;', 'const born = await birth;'))
  check('…and never awaits the birth before the flip', !face.includes('await bornSession('))
  check('the milestones record the order (chat-flipped · birth-landed · birth-refused)', face.includes("recordLaunchMilestone('chat-flipped')") && face.includes("recordLaunchMilestone('birth-landed')") && face.includes("recordLaunchMilestone('birth-refused')"))
  check('a refused birth hands the frame back to the face at once — the absent-chat settle, else the face pushed back over the chat that still held the slot', ordered(face, "recordLaunchMilestone('birth-refused');", 'if (!settleAbsentChat().ok) enterBootSettings();'))
  check('…and mints the warning receipt with the reason on the NEXT macrotask (after the chat’s own subscription has left)', /setTimeout\(\(\) => mintImmediateReceipt\(`▲ the chat could not start — \$\{born\.reason\}`, 'warning'\), 0\)/.test(face))
  check('the face subscribes to the seam and paints the warning where the row note stands', face.includes('subscribeSeatReceipts(r => {') && face.includes("if (r.level === 'warning') setBirthReceipt(r.text);") && face.includes('(list.note ?? birthReceipt ?? \'\')'))
  check('…and a face mounting AFTER the mint reads the row back (the chat’s subscription drained it)', face.includes('useState<string | null>(() => recentWarningReceipt()?.text ?? null)'))
  const door = read('src/services/switchboard/bornSession.ts')
  check('a keyless birth carries NO model: the door’s screen arm is the neutral owner’s word and the frame omits the field', door.includes('screenBirthModel()') && door.includes('...(model !== undefined ? { model } : {}),'))
  check('…and the door drops every inherited or chosen model on a keyless home (no product door ever spells the placeholder)', door.includes('const model = screen === undefined ? undefined : birthModelOf(facts, req.model ?? null, screen)'))
  const milestones = read('src/substrate/launchMilestones.ts')
  check('the milestone kinds exist', ["'chat-flipped'", "'birth-landed'", "'birth-refused'"].every(k => milestones.includes(k)))
  const picker = read('src/screens/ResumeConversation.tsx')
  check('the resume picker parses no transcript before the hop', !picker.includes('loadConversationForResume('))
  check('…and hops on the log’s path and title through the one resume door', picker.includes('focusResumedSession(String(sessionId), log.fullPath, {') && picker.includes('title: log.customTitle ?? log.agentName,') && picker.includes('const sessionId = getSessionIdFromLog(log)'))
  const wm = read('src/services/concourse/workerModels.ts')
  check('the registry admits ONLY a launch with no id at all keyless, the row reading the keyless words', wm.includes("if (arm === 'session' && idOrKey === undefined) return { ok: true, entry: { ...entry, displayName: NO_SIGN_IN_ROW }, keyless: true }") && wm.includes('const unnamed = idOrKey === undefined || (id === defaultId && defaultDispatches)'))
  check('…and its keyless seed is the operator’s own row (the id the face names), so that launch counts as unnamed', ordered(wm, "const firstAvailable = registry.entries.find(e => e[arm].availability === 'available')", 'const operatorRow = registry.entries.find(e => e.isOperatorDefault === true)', 'return registry.entries[0]?.modelId'))
}

section('§2 the seed, pure — a keyless registry seeds the operator’s own row')
{
  const { defaultWorkerModelId } = await import('../../src/services/concourse/workerModels.ts')
  const refused = { availability: 'refused', refusal: 'no-credential:anthropic' } as const
  const registry = {
    schema: 1 as const,
    entries: [
      { modelId: 'claude-sonnet-5', displayName: 'Sonnet 5', session: refused, crew: refused },
      { modelId: 'claude-opus-5', displayName: 'Opus 5', session: refused, crew: refused, isOperatorDefault: true as const },
    ],
  }
  check('nothing dispatches ⇒ the operator’s own row, not the first listed row', defaultWorkerModelId(registry, 'session') === 'claude-opus-5' && defaultWorkerModelId(registry, 'crew') === 'claude-opus-5')
  check('no marked row ⇒ the first row (visible, typed-refused)', defaultWorkerModelId({ schema: 1, entries: [registry.entries[0]!] }, 'session') === 'claude-sonnet-5')
}

section('§3 a live keyless home — the unnamed session admits keyless; the crew seat speaks the two-door sentence')
{
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const wm = await import('../../src/services/concourse/workerModels.ts')
  const { NO_SIGN_IN_ROW, resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.ts')
  resetComputedDefaultMemo()
  check('no neutral default on this home', wm.neutralSeatDefault() === null)
  const unnamed = await wm.validateWorkerModelChoice(undefined, 'session')
  check('an UNNAMED session launch admits KEYLESS (no family refused)', unnamed.ok && unnamed.keyless === true, text(unnamed))
  check('…the row wears the keyless words', unnamed.ok && unnamed.entry.displayName === NO_SIGN_IN_ROW, text(unnamed))
  const { getMainLoopModel } = await import('../../src/utils/model/model.ts')
  const placeholder = getMainLoopModel()
  const named = await wm.validateWorkerModelChoice(placeholder, 'session')
  check(`the placeholder spelled out ('${placeholder}') is a NAMED Claude id on a keyless home — its own family's door (no product door spells it: bornSession drops every model there)`, !named.ok && named.reason === 'no-credential:anthropic' && String(named.action).includes('/logins anthropic'), text(named))
  const crew = await wm.validateWorkerModelChoice(undefined, 'crew')
  check('a keyless CREW seat refuses with the two-door sentence, naming no family', !crew.ok && crew.reason === wm.NO_ACCOUNT_REFUSAL && String(crew.action).includes('/logins to choose an account'), text(crew))
  const other = await wm.validateWorkerModelChoice('claude-sonnet-5', 'session')
  check("a NAMED Claude id that is not the default keeps its own refusal (the operator chose it)", !other.ok && other.reason === 'no-credential:anthropic' && String(other.action).includes('/logins anthropic'), text(other))
}

section('§4 the seam’s order — a listener gone before the mint never sees it; a mint with no listener queues for the next')
{
  const seam = await import('../../src/utils/model/seatReceipts.ts')
  seam.__resetSeatReceiptsForTests()
  const chat: string[] = []
  const stopChat = seam.subscribeSeatReceipts(r => chat.push(r.text))
  stopChat()
  seam.mintImmediateReceipt('▲ the chat could not start — the fixture refused', 'warning')
  check('the chat that unsubscribed never sees the receipt', chat.length === 0, text(chat))
  check('the latest warning is readable by a screen that mounts after the mint', seam.recentWarningReceipt()?.text.includes('could not start') === true, text(seam.recentWarningReceipt()))
  const face: Array<{ text: string; level: string }> = []
  const stopFace = seam.subscribeSeatReceipts(r => face.push({ text: r.text, level: r.level }))
  check('the face subscribing next drains it, warning-level, verbatim', face.length === 1 && face[0]?.level === 'warning' && face[0]?.text.includes('could not start'), text(face))
  stopFace()
  seam.__resetSeatReceiptsForTests()
  check('the reset clears the retained warning', seam.recentWarningReceipt() === null)
}

section('§5 the drive — a keyless one-seat home: ↵ paints the cockpit; a second ↵ is refused and the face wears the receipt')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`✗ the PTY drive needs the POSIX capture engine — ${driver.kind === 'unavailable' ? driver.reason : `driver ${driver.kind}`}`)
  process.exit(1)
}
const captureHome = mkdtempSync(join(tmpdir(), 'birth-flips-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'birth-flips-cwd-')))
const configDir = join(captureHome, '.mercury')
const daemonDir = join(captureHome, 'daemon')
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    // ONE seat: the first birth takes it, the second is refused at the door
    // — the fast, deterministic refusal the leg needs.
    switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 1 },
  }),
)
const ESC = String.fromCharCode(27)
const N = '↑↓ choose'
const after = (ms: number, payload: string): string => `after:${N}:${ms}:${payload}`
const sends = [
  after(1500, '\r'), // 0 ↵ New Session — the chat route flips at once; the keyless birth lands behind
  after(12000, `${ESC}[1;2D`), // 1 ⇧← the concourse
  after(13000, `${ESC}[1;2D`), // 2 ⇧← the face
  after(14500, '\r'), // 3 ↵ again — the one seat is taken: refused after the flip, the face returns with the receipt
]
const WALL_S = driveWallSeconds(sends, { tailMs: 4500 }) // the last grab is at(3) + 4500
const drive = join(captureHome, 'drive.jsonl')
const nodeBin = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim()
const child = spawn(
  driver.python,
  [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', String(WALL_S), '--out', drive, ...sends.flatMap(s => ['--send', s]), '--', nodeBin, DIST],
  {
    cwd,
    env: {
      ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
      HOME: captureHome,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'xterm-256color',
      MERCURY_SPLASH: 'off',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TEAMS_DIR: join(captureHome, 'teams'),
      MERCURY_TABULA_DIR: join(captureHome, 'tabula'),
      // The credential store pinned to the FILE backend under the capture
      // home: on darwin the keychain chain ignores MERCURY_CONFIG_DIR.
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_TERMINAL_TITLE: '0',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
    },
  },
)
let driverOut = ''
child.stdout.on('data', d => (driverOut += d))
child.stderr.on('data', d => (driverOut += d))
const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(WALL_S * 1000) + 22_000)
await driverClosed(child)
clearTimeout(killer)
// exact-pid reap: runners from the records file, then the owned daemon.
const reaped: number[] = []
type Worker = { pid?: number; endedAt?: number; sessionId?: string }
let workers: Record<string, Worker> = {}
try {
  const wf = join(daemonDir, 'concourse-workers.json')
  if (existsSync(wf)) {
    workers = (JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, Worker> }).workers ?? {}
    for (const rec of Object.values(workers)) if (rec.pid !== undefined) { try { process.kill(rec.pid, 'SIGTERM'); reaped.push(rec.pid) } catch {} }
  }
  const supFile = join(daemonDir, 'supervisor.json')
  if (existsSync(supFile)) {
    const pid = (JSON.parse(readFileSync(supFile, 'utf8')) as { pid?: number }).pid
    if (typeof pid === 'number' && pid > 0) { try { process.kill(pid, 'SIGTERM'); reaped.push(pid) } catch {} }
  }
} catch {}
console.log(`  reaped pids: ${reaped.join(',') || 'none live'}`)

type Rec = { sent?: number; ts?: number }
const recs: Rec[] = existsSync(drive) ? readFileSync(drive, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const firstOut = recs.find(r => r.ts !== undefined)?.ts ?? 0
const sendRecs = recs.filter(r => r.sent !== undefined)
const at = (i: number): number => Math.round((sendRecs[i]?.sent ?? firstOut) - firstOut)
check('every send fired (the face painted and took every ↵ and ⇧←)', sendRecs.length === sends.length, `${sendRecs.length}/${sends.length}${sendRecs.length < sends.length ? ` · ${unfiredDetail(driverOut)}` : ''}`)
if (sendRecs.length === sends.length) {
  const res = spawnSync(driver.python, [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive, '120', '40', String(at(0) + 9500), String(at(3) + 4500), '-1'], { encoding: 'utf8', timeout: vshotBudgetMs(120_000), maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`screengrab failed: ${res.stderr}`)
    process.exit(1)
  }
  const screens = (JSON.parse(res.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
  const [chatFrame, refusedFrame, finalFrame] = screens
  const t = (g: { rows: string[] }): string => g.rows.join('\n')
  check('the keyless birth ENTERED the chat: the cockpit painted with the composer’s gate naming the logins door (no refusal naming a family)', /\? for shortcuts/.test(t(chatFrame)) && /\/logins/.test(t(chatFrame)) && !/no-credential:anthropic/.test(t(chatFrame)), chatFrame.rows.filter(r => r.trim().length > 0).slice(-6).map(r => r.trim().slice(0, 100)).join(' | '))
  check('the second ↵ was refused after the flip and the face returned wearing the receipt (the cause named: the seat)', /the chat could not start/.test(t(refusedFrame)) && /seat/i.test(t(refusedFrame)) && /↑↓ choose|New Session/.test(t(refusedFrame)), refusedFrame.rows.filter(r => r.trim().length > 0).slice(-4).map(r => r.trim().slice(0, 110)).join(' | '))
  check('the face keeps the receipt on its last row at the end', /the chat could not start/.test(t(finalFrame)), finalFrame.rows[finalFrame.rows.length - 1]?.trim().slice(0, 110) ?? '')
  // THE MILESTONES (each kind recorded once per process): the chat route
  // flipped BEFORE the first birth landed; the second birth's refusal
  // followed — the frames above carry the second flip's own truth (the
  // face back, wearing the receipt).
  const milestonesPath = join(configDir, 'launch-milestones.json')
  const rows = existsSync(milestonesPath)
    ? ((JSON.parse(readFileSync(milestonesPath, 'utf8')) as { rows?: Array<{ milestone: string; atMs: number }> }).rows ?? [])
    : []
  const names = rows.map(r => r.milestone)
  const flipped = names.indexOf('chat-flipped')
  const landed = names.indexOf('birth-landed')
  const refused = names.indexOf('birth-refused')
  check('the milestones record the flip BEFORE the birth landed, then the second birth’s refusal', flipped !== -1 && landed > flipped && refused > landed, names.join(' → '))
  // NO GHOST: a refused admission wrote no record — exactly one session stands.
  const standing = Object.values(workers).filter(w => w.endedAt === undefined)
  check('the daemon’s records hold exactly ONE session (a refused birth leaves no ghost on the board)', standing.length === 1, text(Object.values(workers).map(w => ({ sessionId: w.sessionId, endedAt: w.endedAt }))))
}

section('§6 THE RESUME SIBLING — a resumed session whose retained model has no credential here is ADMITTED modelless: the receipt names the model and its door, and a shell line runs')
{
  // The wire: the control socket's admit answer picks its fields by the
  // wire-pick law (one key list per relayed result), so the note must be a
  // listed key — an unlisted field is a silent drop of the receipt (the
  // find: the cockpit painted with no row at all).
  const socket = read('src/daemon/controlServer.ts')
  check('the admit answer carries the retained-model note across the control socket', /const ADMIT_WIRE_KEYS = \[[^\]]*'note'[^\]]*\]/.test(socket))
  const supervisor6 = read('src/daemon/concourseSupervisor.ts')
  check('the admission re-validates a refused retained model UNNAMED and mints the note on every ok road', supervisor6.includes("validated.reason.startsWith('no-credential:')") && supervisor6.split('retainedNote !== undefined').length >= 4)
  check('the resume door paints the note on the screen-receipt seam', read('src/services/switchboard/hopIntoSession.ts').includes("if (typeof reply.note === 'string' && reply.note !== '') mintImmediateReceipt(`▲ ${reply.note}`, 'warning')"))
  // The seed: a durable session of this folder that RAN on claude-opus-5
  // (its record and its transcript both say so), resumed on a keyless home.
  // The old law refused it by name and the revived session had no runner —
  // even a shell line could not run.
  const home2 = mkdtempSync(join(tmpdir(), 'resume-keyless-home-'))
  const cwd2 = realpathSync(mkdtempSync(join(tmpdir(), 'resume-keyless-cwd-')))
  const configDir2 = join(home2, '.mercury')
  const daemonDir2 = join(home2, 'daemon')
  mkdirSync(configDir2, { recursive: true })
  mkdirSync(daemonDir2, { recursive: true })
  writeFileSync(
    join(configDir2, '.config.json'),
    JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, projects: { [cwd2]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }),
  )
  const sessionId2 = '11111111-2222-4333-8444-555555555555'
  const NOW = Date.now()
  const workers2 = {
    'w-old': { schema: 1, runnerId: 'w-old', sessionId: sessionId2, workspaceId: cwd2, isolation: 'shared', modelKey: 'claude-opus-5', spawnedAt: NOW - 7 * 60_000, lastLiveAt: NOW - 6 * 60_000, endedAt: NOW - 5 * 60_000 },
  }
  writeFileSync(join(daemonDir2, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers: workers2 }, null, 1)}\n`)
  // The transcript where the path law puts it FOR THE CHILD's config home
  // (the path owner resolves the env at call time).
  const prevCfg = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = configDir2
  const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
  const file2 = workerTranscriptPath({ sessionId: sessionId2, workspaceId: cwd2 })
  if (prevCfg === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevCfg
  const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
  mkdirSync(dirname(file2), { recursive: true })
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: cwd2,
    sessionId: sessionId2,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date(NOW - 6 * 60_000).toISOString(),
    ...extra,
  })
  writeFileSync(
    file2,
    encodeSeedTranscript(
      [
        row({ type: 'user', message: { role: 'user', content: 'resume me' } }),
        row({ type: 'assistant', message: { id: 'msg_5555', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
      ] as never,
      sessionId2,
    ),
  )
  const hint = '? for shortcuts'
  const sends2 = [
    `after:${hint}:2500:!echo resumed-ok`, // 0 a shell line into the resumed chat
    `after:${hint}:3300:\r`, // 1 ↵ runs it
  ]
  const drive2 = join(home2, 'drive.jsonl')
  const child2 = spawn(
    driver.python,
    [join(REPO, 'scripts', 'streaming', 'ptydrive.py'), '--cols', '120', '--rows', '40', '--seconds', '24', '--out', drive2, ...sends2.flatMap(s => ['--send', s]), '--', nodeBin, DIST, '--resume', sessionId2],
    {
      cwd: cwd2,
      env: {
        ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
        HOME: home2,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: configDir2,
        MERCURY_DAEMON_DIR: daemonDir2,
        MERCURY_TEAMS_DIR: join(home2, 'teams'),
        MERCURY_TABULA_DIR: join(home2, 'tabula'),
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_TERMINAL_TITLE: '0',
        MERCURY_CRITTER_IDLE: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CRITTER_SLEEP: '0',
        MERCURY_LIVE_CLOCK: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_TURN_RECEIPT: '0',
        MERCURY_OASIS_BG: '0',
      },
    },
  )
  let driverOut2 = ''
  child2.stdout.on('data', d => (driverOut2 += d))
  child2.stderr.on('data', d => (driverOut2 += d))
  const killer2 = setTimeout(() => child2.kill('SIGKILL'), vshotBudgetMs(24_000) + 22_000)
  await driverClosed(child2)
  clearTimeout(killer2)
  let workersAfter: Record<string, Worker & { keyless?: boolean; modelKey?: string }> = {}
  try {
    const wf = join(daemonDir2, 'concourse-workers.json')
    if (existsSync(wf)) {
      workersAfter = (JSON.parse(readFileSync(wf, 'utf8')) as { workers?: Record<string, Worker & { keyless?: boolean; modelKey?: string }> }).workers ?? {}
      for (const rec of Object.values(workersAfter)) if (rec.pid !== undefined) { try { process.kill(rec.pid, 'SIGTERM') } catch {} }
    }
    const supFile = join(daemonDir2, 'supervisor.json')
    if (existsSync(supFile)) {
      const pid = (JSON.parse(readFileSync(supFile, 'utf8')) as { pid?: number }).pid
      if (typeof pid === 'number' && pid > 0) { try { process.kill(pid, 'SIGTERM') } catch {} }
    }
  } catch {}
  const recs2: Rec[] = existsSync(drive2) ? readFileSync(drive2, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const firstOut2 = recs2.find(r => r.ts !== undefined)?.ts ?? 0
  const sendRecs2 = recs2.filter(r => r.sent !== undefined)
  const at2 = (i: number): number => Math.round((sendRecs2[i]?.sent ?? firstOut2) - firstOut2)
  check('the resumed chat painted its cockpit and took the shell line (every send fired)', sendRecs2.length === sends2.length, `${sendRecs2.length}/${sends2.length}${sendRecs2.length < sends2.length ? ` · ${unfiredDetail(driverOut2)}` : ''}`)
  if (sendRecs2.length === sends2.length) {
    const res2 = spawnSync(driver.python, [join(REPO, 'scripts', 'streaming', 'screengrab.py'), drive2, '120', '40', String(at2(0) - 200), '-1'], { encoding: 'utf8', timeout: vshotBudgetMs(120_000), maxBuffer: 256 * 1024 * 1024 })
    if (res2.status !== 0) {
      console.error(`screengrab failed: ${res2.stderr}`)
      process.exit(1)
    }
    const [beforeLine, final2] = (JSON.parse(res2.stdout) as { screens: { atMs: number; rows: string[] }[] }).screens
    const t2 = (g: { rows: string[] }): string => g.rows.join('\n')
    check('the resumed session was ADMITTED — the cockpit, never a refusal naming the retained model', /\? for shortcuts/.test(t2(beforeLine)) && !/model refused/.test(t2(beforeLine)), beforeLine.rows.filter(r => r.trim().length > 0).slice(-5).map(r => r.trim().slice(0, 100)).join(' | '))
    check("the receipt names the dropped model and its door — the first model send picks the neutral default, /model chooses", /has no credential here/.test(t2(beforeLine)) && /claude-opus-5/.test(t2(beforeLine)) && /\/model chooses/.test(t2(beforeLine)), beforeLine.rows.filter(r => /credential|model/.test(r)).map(r => r.trim().slice(0, 110)).join(' | '))
    check('the shell line RAN on the modelless runner — its output stands in the transcript', final2.rows.some(r => /resumed-ok/.test(r) && !/echo/.test(r)), final2.rows.filter(r => /resumed-ok/.test(r)).map(r => r.trim().slice(0, 100)).join(' | '))
    const revived = Object.values(workersAfter).find(w => w.sessionId === sessionId2 && w.endedAt === undefined)
    check('the revived record is stamped KEYLESS (a later sign-in takes the neutral default; the retained model is not carried)', revived !== undefined && revived.keyless === true, text(Object.values(workersAfter).map(w => ({ sessionId: w.sessionId, endedAt: w.endedAt, keyless: w.keyless, modelKey: w.modelKey }))))
  }
  rmSync(home2, { recursive: true, force: true })
  rmSync(cwd2, { recursive: true, force: true })
}

rmSync(captureHome, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-birth-flips-first: THE FIRST CHAT PAINTS AT ONCE' : `\nprove-birth-flips-first: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
