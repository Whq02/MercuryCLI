#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-chat-mode-polish.ts — THE PLAIN WORLD AS A
//  COMPLETE PRODUCT (the operator: "fleet manager
//  on normal mercury / agent OS, and effective CLI in chat mode"). The pure
//  pins over the surfaces that must not assume, mention, hint at or leave a
//  hole for the concourse in a `--chat` boot or with the concourse switched
//  off. The command table's half lives in prove-command-table C6, the
//  router's why and sentence in prove-surface-strip §7, the real-boot
//  captures in prove-chat-mode-drive.
//
//   §A  THE ⚑ BADGE'S JUMP: the fleet world names the board and its chord;
//       the plain world names the chat itself when every waiting ask is the
//       focused chat's own, else the estate's resume door (/resume) — never
//       "board", never the chord. POISON: "board" beside the badge in the
//       plain world.
//   §B  THE RAIL: the concourse chip stays the explicit door in the plain
//       world but says what it opens (the live view) and its hover names
//       the way back — no "every session, one board" there.
//   §C  THE SHORTCUTS TAB: ctrl+x c's label per world; the row object keeps
//       its action · context · fallback triple (the registry proof stands).
//
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'chat-mode-polish-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_FULLSCREEN = '1'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

t.section('§A — the ⚑ badge\'s jump per world')
{
  const { needsYouJump } = await import('../../src/components/mercury-ui/needsYouJump.ts')
  const chord = 'ctrl+x c'
  t.check('the fleet world names the board and its chord', needsYouJump({ plain: false, ownOnly: false, boardChord: chord }) === 'ctrl+x c board')
  t.check('the fleet world names the board even when every ask is the chat\'s own (the board lists it too)', needsYouJump({ plain: false, ownOnly: true, boardChord: chord }) === 'ctrl+x c board')
  t.check('the plain world, every ask the focused chat\'s own: "this chat"', needsYouJump({ plain: true, ownOnly: true, boardChord: chord }) === 'this chat')
  t.check('the plain world, another session\'s ask: the estate\'s resume door (/resume — the face\'s Continue/Resume from inside the chat)', needsYouJump({ plain: true, ownOnly: false, boardChord: chord }) === '/resume')
  t.check('POISON absent: the plain world never says "board" and never names the chord', [true, false].every(own => { const j = needsYouJump({ plain: true, ownOnly: own, boardChord: chord }); return !j.includes('board') && !j.includes(chord) }))
  t.check('the jump follows a rebind in the fleet world (the resolver\'s display, never a copied string)', needsYouJump({ plain: false, ownOnly: false, boardChord: 'alt+b' }) === 'alt+b board')
  const frame = read('src/components/MercuryFrame.tsx')
  t.check('the frame reads the world from the router and the jump from the one helper; the count stays (a need is a need)', frame.includes('plain: chatOnlyBoot(),') && frame.includes("bucketItems(attentionView.attention, 'needs-you').every(item => item.owner === 'command-queue')") && frame.includes('{FLAG_ICON} {needsYouCount(attentionView.needsYou)}') && frame.includes('· {needsJump}') && !frame.includes('{boardChord} board'))
}

t.section('§B — the rail: the door stays, its words follow the world')
{
  const rail = read('src/components/mercury-ui/SessionTabs.tsx')
  t.check('the rail reads the world from the router', rail.includes('const plainWorld = chatOnlyBoot()'))
  t.check('the chip is still the explicit door (/concourse dispatch) in both worlds', (rail.match(/requestCommandDispatch\('\/concourse'\)/g) ?? []).length === 2)
  t.check('the inline chip says "live view" in the plain world, "concourse" in the fleet world', rail.includes("{plainWorld ? 'live view' : 'concourse'}"))
  t.check('the hover names what the door opens and the way back in the plain world — never "one board" there', rail.includes('live view of your sessions \\u2014 the concourse is off in this boot; ${concourseWayBack()}') && rail.includes("? plainWorld\n      ? `   \\u21b3 live view") && rail.includes("'   \\u21b3 Session Concourse \\u2014 every session, one board \\u00b7 click to open'"))
}

t.section('§C — the shortcuts tab: ctrl+x c\'s label per world, the triple untouched')
{
  const { EVERYDAY } = await import('../../src/components/HelpV2/ShortcutsTab.tsx')
  const row = EVERYDAY.rows.find(r => r.action === 'app:openSurfaceSwitcher')
  t.check('the row keeps its registry triple (action · context · fallback)', row !== undefined && row.context === 'Global' && row.fallback === 'ctrl+x c')
  t.check('the row carries both labels: the board in the fleet world, the live view (and that the concourse is off) in the plain world', row?.label === 'session concourse — every surface, one board' && row?.plainLabel === 'live view of your sessions — the concourse is off in this boot')
  t.check('only the concourse row has a plain-world label', EVERYDAY.rows.filter(r => r.plainLabel !== undefined).length === 1)
  const tab = read('src/components/HelpV2/ShortcutsTab.tsx')
  t.check('the row picks its label from the router\'s world at render', tab.includes("const label = row.plainLabel !== undefined && chatOnlyBoot() ? row.plainLabel : row.label"))
}

// L15 (the operator's word): `--chat` BOOTS ON THE BOOT MENU — not an
// explicit journey, no session born at boot; ↵ New Session is the door. The
// felt path is the face's own: the REPL's mount hook warms the daemon and
// its runner beneath the face, so that ↵ claims a booted runner (the
// one-door drive's budget). The born-and-focused landing and the root-
// action preheat that served it retire.
t.section('§D — the felt path (L15): `--chat` lands on the boot menu, and ↵ New Session is the warm road')
{
  const main = read('src/main.tsx')
  t.check('--chat is not an explicit journey (the landing rule lands the face) and births nothing at boot', main.includes('if (opts.continue || opts.resume || opts.fromPr || inputPrompt) {') && main.includes('if (promptIsWords || !isFullscreenEnvEnabled()) {') && !main.includes('opts.chat === true || promptIsWords'))
  t.check('the --chat mark still holds (the plain world for this boot; no third flag)', /if \(opts\.chat === true\) \{[\s\S]*?markChatBoot\(\)/.test(main))
  t.check("no root-action preheat remains — the menu's mount warms the daemon and its runner beneath the face (the REPL's own hook, unconditional at mount)", !main.includes('program.opts().chat === true') && read('src/screens/REPL.tsx').includes('if (await m.ensureOwnedDaemon()) await m.warmSessionRunner(getCwd());'))
  t.check('the option help says the menu is the landing and ↵ New Session the door', main.includes('↵ New Session on the menu starts the chat') && main.includes('`-chat` is the same switch'))
  const supervisor = read('src/daemon/concourseSupervisor.ts')
  t.check('the admit road claims the warm runner for a fresh exclusive-or-shared birth with no runner options (the ↵ birth is one)', supervisor.includes('req.resumeSessionId === undefined &&') && supervisor.includes("(effectiveIsolation === 'exclusive' || effectiveIsolation === 'shared') &&") && supervisor.includes('(req.runnerArgv === undefined || req.runnerArgv.length === 0)'))
  t.check('the pool drives measure the felt ↵ on the --chat face (prove-chat-mode-drive F1/F2, prove-one-door-drive L3)', read('scripts/switchboard/prove-chat-mode-drive.ts').includes('warm claim acked in (\\d+)ms') && read('scripts/switchboard/prove-one-door-drive.ts').includes("id: 'l3-chat-menu'"))
}

// L15 (the operator's word) for the --chat twin: NO Session Concourse
// row — New Session is the door, the menu is always behind the chat; the
// --concourse-off twin KEEPS the row as its live-view door (RULING B) with
// the honest ctx. The row's absence derives from the --chat MARK alone,
// never from the world fact (the two twins differ here and nowhere else).
t.section('§E — the boot face per twin: no row in --chat; the live-view door in --concourse-off')
{
  const { concourseRowCtx } = await import('../../src/components/BootSplashScreen.tsx')
  t.check('the fleet world names the live board (and its live count)', concourseRowCtx({ live: true, why: null, liveCount: 0 }) === 'the live board' && concourseRowCtx({ live: true, why: null, liveCount: 3 }) === 'the live board · 3 live')
  t.check('the saved switch off: "live view only — concourse off" (the bytes the strip drive\'s S5 and the one-door drive\'s L4b pin)', concourseRowCtx({ live: true, why: 'concourse off', liveCount: 0 }) === 'live view only — concourse off')
  t.check('an unregistered surface dims with its reason', concourseRowCtx({ live: false, why: null, liveCount: 0 }) === 'unregistered in this build' && concourseRowCtx({ live: false, why: 'concourse off', liveCount: 0 }) === 'unregistered in this build')
  t.check('POISON absent: the switch-off world never says "the live board"', !concourseRowCtx({ live: true, why: 'concourse off', liveCount: 2 }).includes('the live board'))
  const face = read('src/components/BootSplashScreen.tsx')
  t.check('the face reads the world from the router (plainWorldWhy) and the --chat MARK from its facts (stripFacts().chatBoot) — never the switch alone', face.includes('const plainWhy = plainWorldWhy();') && face.includes('const chatBoot = stripFacts().chatBoot;') && !face.includes('concourseEnabled()'))
  t.check('--chat: the face passes NO concourse row (the mark, not the world fact); --concourse-off: the row with its ctx', face.includes('concourse: chatBoot\n          ? null') && face.includes('ctx: concourseRowCtx({ live: concourseLive, why: plainWhy, liveCount })'))
  t.check("--chat: the 'o' door goes with the row; --concourse-off keeps it", face.includes("...(chatBoot ? [] : [{ key: 'o', hint: 'concourse', run: (): null => (enterConcourse(), null) }])"))
  t.check('--chat: the face never imports the supervisor for a row it does not carry', face.includes('if (chatBoot) return; // no row to count for'))
  t.check("the key-map row is the strip's own text (stripKeyMapHint), never a hardcoded move", face.includes('const keyMapHint = stripKeyMapHint();') && face.includes('KEY_MAP_ROW(core, keyMapHint)') && !face.includes('⇧←→ move between screens'))
  // Re-pinned: the Resume row's estate door is the
  // face-native picker (BootResumeScreen — whose ↵ rides the same
  // focusResumedSession door) and Continue rides that door DIRECTLY (the
  // armed road retired); the law is unchanged — none of these rows ride
  // the concourse.
  t.check("Projects / Continue / Resume ride the estate's own doors, none the concourse (the boot menu is the solo road — C4/B1: Projects never dims)", face.includes('focusResumedSession(sid, target.transcriptPath ?? undefined') && face.includes('setResumeOpen(true)') && face.includes('hop.focusResumedSession(p.sessionId') && !face.includes('projectsDim') && read('src/components/BootResumeScreen.tsx').includes('hop.focusResumedSession(String(sessionId)'))
  // THE SEAM: the shared core skips a null row; the launcher marks a --chat
  // launch and the splash passes null too, so frame 0 and the face compose
  // the same six rows at both sizes (the drive's P1/P2 capture them).
  const core = read('assets/splash/splash-core.mjs')
  t.check('the shared core composes no concourse row for a null (both hosts)', core.includes('if (facts.concourse) {') && core.includes("key: 'concourse',"))
  const { assembleCardRows } = await import('../../assets/splash/splash-core.mjs')
  const keysOf = (concourse: { ctx: string } | null): string[] => (assembleCardRows({ cwdBase: 'proj', continueTarget: null, menuAvailable: true, concourse, projects: [] }) as Array<{ key: string }>).map(r => r.key)
  t.check('the --chat card carries no concourse key and is exactly one row shorter than the card that does', !keysOf(null).includes('concourse') && keysOf({ ctx: 'the live board' }).includes('concourse') && keysOf({ ctx: 'x' }).length === keysOf(null).length + 1)
  t.check('the launcher exports the --chat mark for the splash and the splash composes the --chat card from it', read('scripts/ops/launcher-mercury.sh').includes('--chat|-chat) export MERCURY_SPLASH_CHAT=1 ;;') && read('assets/splash/mercury-splash.mjs').includes("concourse: process.env.MERCURY_SPLASH_CHAT === '1' ? null : { ctx: 'the multi-session board, once' }"))
  t.check('the new env read has its flag-registry row (consumer: the splash)', read('src/substrate/flagRegistry.ts').includes("env: 'MERCURY_SPLASH_CHAT'"))
  t.check("the boot settings layer's 'o' door is absent in --chat too, kept in --concourse-off", read('src/components/BootSettingsScreen.tsx').includes('...(concourseLive && !chatBoot') && read('src/components/BootSettingsScreen.tsx').includes("${concourseLive && !chatBoot ? ` · o ${plainWorld ? 'live view' : 'concourse'}` : ''}"))
}

// THE SWEEP (item 6): the plain world's paint carries no concourse
// vocabulary for a screen this boot cannot have — every hit is either
// honest (it names the live view and the way back) or silent there.
t.section('§F — the sweep: board vocabulary follows the world or falls silent')
{
  const tips = read('src/services/tips/tipRegistry.ts')
  // The seat-board tip retired with the router party (the rule:
  // a tip advertising a retired door is the seams class the delete lane
  // missed); the two living board tips stay world-gated, and the retired
  // tip's id never returns.
  t.check('the two board tips (concourse · workflows) stay silent in the plain world; the retired seat-board tip is gone', (tips.match(/async isRelevant\(\) \{\n\s+return !chatOnlyBoot\(\)\n\s+\}/g) ?? []).length === 2 && tips.includes("id: 'concourse-board'") && tips.includes("id: 'workflows-board'") && !tips.includes("id: 'party-seats'") && !tips.includes('/party'))
  t.check('the /sessions tip stays in every world (the plain CLI\'s own)', /id: 'sessions-switch',[\s\S]*?async isRelevant\(\) \{\n\s+return true/.test(tips))
  const bank = read('src/utils/cockpit/companionWords.ts')
  t.check("the companion's /workflows, /teammates and /fleet tips carry the world gate; the text is untouched", bank.includes("'/workflows shows runs, live and past.', 'workflows', fleetWorld)") && bank.includes("'/teammates keeps named long-run helpers.', 'teammates', fleetWorld)") && bank.includes("'/fleet shows who is working right now.', 'fleet', fleetWorld)") && bank.includes('const fleetWorld = (): boolean => !chatOnlyBoot()'))
  const settings = read('src/components/BootSettingsScreen.tsx')
  t.check("the boot settings' 'o' door names the live view in the plain world (hint and legend)", settings.includes("hint: plainWorld ? 'open the live view' : 'open concourse'") && settings.includes("` · o ${plainWorld ? 'live view' : 'concourse'}`"))
  const concourseCmd = read('src/commands/concourse/index.ts')
  t.check('/concourse\'s description says what the door opens per world, read live', concourseCmd.includes('get description(): string {') && concourseCmd.includes("'Open the live view of your sessions — the concourse is off in this boot'") && concourseCmd.includes("'Open the Session Concourse — the multi-session home board, in place'"))
  const connector = read('src/services/engine-connector/daemonConnector.ts')
  t.check('a refused resume names no concourse (the daemon resumes it; the sentence is the same in both worlds)', connector.includes('`the session could not resume — ${refusal} · ↵ again retries`') && !connector.includes('could not resume on the concourse'))
  t.check('/tasks\' workflow pointers to the run board fall silent in the plain world', read('src/components/tasks/BackgroundTasksDialog.tsx').includes("work.kind === 'workflow' && !chatOnlyBoot() ? '; /workflows opens the run board' : ''") && read('src/components/tasks/RunDetailPane.tsx').includes("`paused — finished agents stay cached${chatOnlyBoot() ? '' : '; R on the board resumes it'}`"))
  t.check('the substrate catalogue lists /deck and /fleet as off in the plain world (/trace stays)', read('src/utils/cockpit/substrateSnapshot.ts').includes("{ name: '/trace', on: true, hint: 'always-on (fork) · /deck and /fleet are off in this boot — the concourse is off' }"))
  // The census over the plain world's own paint: the fleet-world-only words
  // appear in these files ONLY inside a world-gated arm.
  const gatedFiles = ['src/components/MercuryFrame.tsx', 'src/components/mercury-ui/SessionTabs.tsx', 'src/components/HelpV2/ShortcutsTab.tsx', 'src/components/BootSplashScreen.tsx', 'src/components/BootSettingsScreen.tsx']
  for (const f of gatedFiles) {
    const src = read(f)
    const lines = src.split('\n')
    const GATED = /plainWorld|plainWhy|why|needsYouJump|chatOnlyBoot|plainLabel|\/\/|\*/
    const bare = lines.filter((l, i) => /one board|the live board|\bo concourse\b|\} board`/.test(l) && !GATED.test(lines.slice(Math.max(0, i - 2), i + 2).join('\n')))
    t.check(`${f}: every "board" line is world-gated or a comment`, bare.length === 0, bare.join(' | ').slice(0, 200))
  }
}

// L18 (the operator's word): THE BOOT MENU'S SETTINGS ARE THE NEXT
// SESSION'S — one next-session-facts record (the bootBirthFacts seam,
// extended) read once by every birth/resume door; never a running session.
// The menu's env rows reach the next session through the daemon's
// per-admission snapshot; the record carries what env cannot (the model).
t.section('§G — the next-session facts (L18): one record, every door, never a running session')
{
  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  facts._resetBootBirthFactsForTesting()
  facts.setNextSessionFacts({ title: 'once', model: 'claude-opus-5', effort: 'max', permissionMode: 'plan' as never, runnerArgv: ['--x'] })
  t.check('the title is ONE-SHOT: the first taker consumes it, the second reads null', facts.takeBootTitle() === 'once' && facts.takeBootTitle() === null)
  t.check('model · effort · permissionMode · runnerArgv are STICKY: two reads, one answer', facts.bootBirthFacts().model === 'claude-opus-5' && facts.bootBirthFacts().model === 'claude-opus-5' && facts.bootBirthFacts().effort === 'max' && (facts.bootBirthFacts().permissionMode as string) === 'plan' && facts.bootBirthFacts().runnerArgv.join(',') === '--x')
  t.check("the model precedence: the record (the menu's explicit choice) → a door's inheritance → the screen's main model", facts.birthModelOf({ model: 'a' }, 'b', 'c') === 'a' && facts.birthModelOf({ model: null }, 'b', 'c') === 'b' && facts.birthModelOf({ model: null }, null, 'c') === 'c' && facts.birthModelOf({ model: null }, undefined, 'c') === 'c')
  facts._resetBootBirthFactsForTesting()
  const born = read('src/services/switchboard/bornSession.ts')
  t.check('THE ONE BIRTH DOOR reads the record through the precedence', born.includes('const model = birthModelOf(facts, req.model ?? null, getMainLoopModel())'))
  const face = read('src/components/BootSplashScreen.tsx')
  t.check("the face's births pass NO explicit model — the record decides (New Session and the Projects birth)", !face.includes('model: getMainLoopModel()') && face.includes('bornSession({ workspaceDir: process.cwd() })') && face.includes('bornSession({ workspaceDir: p.dir })'))
  t.check("the board's tab passes none; /clear keeps its door inheritance (the cleared chat's model — outranked only by the record)", read('src/components/concourse/ConcourseRoute.tsx').includes('bornSession({ workspaceDir: ground })') && read('src/screens/REPL.tsx').includes('bornSession({ workspaceDir: getCwd(), model: getFocusedSessionConnector().modelFacts().effective })'))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  t.check("THE RESUME DOOR reads the record's posture when its caller passes none (the face's Continue, the picker, the parked row); the session's model and effort stay its own", hop.includes('opts?.permissionMode ?? bootBirthFacts().permissionMode ?? undefined') && !hop.includes('model: bootBirthFacts'))
  const seam = read('src/services/switchboard/bootBirthFacts.ts')
  // Type-only imports are erased at compile — not a live door; the law here is
  // RUNTIME coupling (a value import, a dynamic import, an RPC), so the needle
  // reads the seam with type-only import lines removed (kit-record's
  // `import type { SessionKitV1 } from '../../daemon/sessionKit.js'` is lawful).
  const seamRuntime = seam.replace(/^import type .*$/gm, '')
  t.check("the record's writers touch nothing running: no connector, no daemon, no RPC in the seam — and the settings write door is the SAME record", !seamRuntime.includes('engine-connector') && !seamRuntime.includes('daemon/') && !seamRuntime.includes('daemonControlRpc') && seam.includes('export const setNextSessionFacts = setBootBirthFacts'))
  // The menu's env rows are next-session class END TO END: the profile is
  // read per admission, and a stale warm runner is retired, so a row
  // changed on the menu reaches the next session — never a running one.
  const menu = await import('../../src/substrate/startupMenu.ts')
  const profPath = join(SCRATCH, 'boot-env.json')
  const a = menu.resolveEffectiveSettingsSnapshot({ sessionId: 's', path: profPath, env: {} })
  // The law is about the PROFILE being read per admission, not about any one
  // row: it rides the first living menu row that offers a choice, so a row's
  // retirement can never crash this pin again (the seat-board row it once
  // named died with the router party, and `find(...)!` dereferenced undefined).
  const menuRow = (menu.STARTUP_MENU as ReadonlyArray<{ env: string }>).find(r => menu.menuRowChoices(r as never).some(c => c.value !== null))
  t.check('a living menu row with a choice exists to carry the per-admission law', menuRow !== undefined, 'STARTUP_MENU offers no row with a choice')
  const choice = menuRow ? (menu.menuRowChoices(menuRow as never).find(c => c.value !== null)!.value as string) : ''
  const saved = menuRow ? menu.saveBootDefaultsProfile({ [menuRow.env]: choice }, profPath) : { ok: false as const }
  const b = menu.resolveEffectiveSettingsSnapshot({ sessionId: 's', path: profPath, env: {} })
  t.check("a menu row changed AFTER boot changes the next session's snapshot (the profile is read per admission, not once at boot)", menuRow !== undefined && saved.ok === true && a.snapshotId !== b.snapshotId && b.rows.find(r => r.env === menuRow.env)?.source === 'profile')
  const warm = read('src/daemon/warmRunner.ts')
  t.check('the warm pool never serves a stale snapshot (the settings-drift guard retires it; admission spawns fresh)', warm.includes('currentSnapshotId() !== entry.snapshotId') && warm.includes("retireWarmRunner(args.workspaceId, 'settings-drift', deps)"))
  t.check('the daemon resolves the snapshot per admission (the claim and the cold road both)', (read('src/daemon/concourseSupervisor.ts').match(/resolveEffectiveSettingsSnapshot\(\{ sessionId/g) ?? []).length >= 2)
  // --chat (L18's closing line): the menu is the only door, and shift+→
  // moves nothing until a session exists.
  const route = await import('../../src/context/surfaceRoute.ts')
  const plain = { concourseEnabled: true, chatBoot: true, chatPresent: false }
  t.check('--chat before a session: the menu alone; shift+→ moves nothing (the dim hint, no commit)', route.stripStops(plain).join(',') === 'boot-settings' && JSON.stringify(route.stripMove('boot-settings', 'right', route.stripStops(plain))) === JSON.stringify({ to: null, hint: 'no chat open' }))
}

rmSync(SCRATCH, { recursive: true, force: true })
t.finish('prove-chat-mode-polish')
