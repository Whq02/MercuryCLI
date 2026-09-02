#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-one-door-lifecycle.ts — LAW 9 at its seams (the
//  one-door lifecycle law, operator-ratified): the session is
//  the unit; every screen is a view. The pins here are its rules
//  read back off the tree — source seams and pure units, no boot (the
//  driven halves live in prove-one-door-drive.ts for the pool).
//
//   R  RESUME BRINGS UP THE WHOLE HOUSE (rule 3): every resume road funnels
//      through the ONE resume path; the estate (daemon + warm runner) comes
//      up behind EVERY landing from the screen's own mount hook; a resume
//      boot is an explicit journey (the chat is the landing); the strip's
//      order keeps the concourse one shift+→ away. Pinned, not rebuilt.
//   C  CLOSE ALL CHATS ⇒ THE BOOT MENU (rule 5): the last board row's
//      release rests the slot (G7 — no ghost at the screen's cwd) and,
// The operator's ruling on the ONLY
//      session: THE BOARD STAYS — the strip drops to its two
//      stops, never a bounce to the menu; the root REPL yields to the boot
//      menu whenever it would front a resting slot (one owner); /clear
//      PARKS the old chat FIRST (law 1 of the reactivation lifecycle: a
//      /clear'd chat is parked, on the board, reactivatable) and births a
//      fresh session, a refused birth resting the slot.
//   F  THE FLAGS (the amendment): the banked single-dash spellings admit
//      (pure), `--chat` is an explicit chat-forward journey born at boot,
//      `--concourse-off` is a REGISTERED persisted field (default on, set
//      never heal-repainted, survives a re-read from disk in a fresh
//      process), the symmetric `--concourse-on` and the /config row are
//      its only other writers; with it off the boot never auto-enters the
//      concourse, the concourse route renders the reduced stage, and the
//      boot menu keeps Projects un-dimmed (B1).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'one-door-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

// ── R: resume brings up the whole house ─────────────────────────────────────
console.log('R — resume brings up the whole house (rule 3)')
{
  const main = read('src/main.tsx')
  const resumeAt = main.indexOf('const resumeAtBoot = async')
  const resumeBody = resumeAt !== -1 ? main.slice(resumeAt, main.indexOf('if (opts.continue) {', resumeAt)) : ''
  check('R1 --continue / --resume <id> ride the ONE resume path at boot', resumeBody.includes('focusResumedSession(sessionId, log.fullPath'))
  check('R1 the boot resume carries the resolved posture (parity with a birth)', resumeBody.includes('permissionMode: args.permissionMode'))
  const face = read('src/components/BootSplashScreen.tsx')
  // Re-pinned: Continue rides the ONE resume path
  // DIRECTLY now (the armed '/resume <id>' road retired whole) — same
  // door, same law, one fewer indirection; the boot's resolved posture
  // still rides it.
  check('R1 Boot › Continue rides the ONE resume path directly with the resolved posture', face.includes('focusResumedSession(sid, target.transcriptPath ?? undefined') && face.includes('permissionMode: permissionModeRef.current'))
  check('R1 Projects-↵ rides the ONE resume path with the row transcript', face.includes('focusResumedSession(p.sessionId, p.transcriptPath'))
  const repl = read('src/screens/REPL.tsx')
  const mountAt = repl.indexOf('// ── boot-time work (mount once; nothing here may touch the paint path) ──')
  const mountBody = repl.slice(mountAt, repl.indexOf('// The context-window sources', mountAt))
  check('R2 the estate comes up behind EVERY landing: the mount hook heals the daemon and arms the warm runner, ungated by the journey', mountBody.includes('ensureOwnedDaemon()') && mountBody.includes('warmSessionRunner(getCwd())') && !/if \(.*(resume|continue|journey)/i.test(mountBody))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  // Re-anchored at the pin-repoint sweep: focusResumedSession
  // went sync — the body's relations are what the law pins.
  const fnAt = hop.indexOf('export function focusResumedSession(')
  const fnBody = hop.slice(fnAt, hop.indexOf('async function paintResumeRecap', fnAt))
  check('R3 a session live on the board is ENTERED (a hop — nothing respawns); a durable one is admitted behind its paint', fnAt !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') < fnBody.indexOf("op: 'sessionAdmit'") && fnBody.includes('resumeSessionId: sessionId'))
  // L15: --chat is NO explicit journey — it lands on
  // the boot menu like a bare boot, so the journey disjunction must NOT
  // carry opts.chat, and the landed comment says it in place.
  check('R4 the resume boots are explicit journeys (the chat is the landing, the menu one shift away) — and --chat is NOT one of them (L15)', main.includes('if (opts.continue || opts.resume || opts.fromPr || inputPrompt) {') && main.includes('markExplicitBootJourney()') && !main.includes('inputPrompt || opts.chat === true) {') && main.includes('`--chat`\n    // is NOT one of them: it lands on the boot face like a bare boot (L15).'))
  const route = read('src/context/surfaceRoute.ts')
  // The reserved
  // chat stop retires — the strip counts its stops from what exists, so
  // the order is [boot menu · concourse · chat] with the chat present only
  // while a session is focused (the pure table lives in
  // scripts/notifications/prove-surface-strip.ts). Switching stays: from
  // the focused chat shift+← is the board.
  check('R5 switching unchanged: the strip keeps [boot menu · concourse · chat] in order, the chat stop counted from the focused slot (the reserved third stop retires)', route.includes("export const STRIP_ORDER: readonly StripStop[] = ['boot-settings', 'concourse', 'repl']") && route.includes("if (facts.chatPresent) stops.push('repl')") && !route.includes("const order = ['repl', 'concourse', 'boot-settings'] as const"))
}

// ── C: close all chats ⇒ the boot menu ──────────────────────────────────────
console.log('C — close all chats ⇒ the boot menu (rule 5)')
{
  const board = read('src/components/concourse/ConcourseRoute.tsx')
  const removeAt = board.indexOf('removeSession: sessionId => {')
  const removeBody = board.slice(removeAt, board.indexOf('noteControl(\n              \'strip:composer\',\n              reply.ok === true && reply.settled !== false', removeAt))
  check('C1 releasing the focused row re-points at a SURVIVOR first (the reaped-session ghost stays closed)', removeBody.includes('hops.hopIntoBoardSession(next.sessionId)'))
  // The last row's release
  // rests the slot and THE BOARD STAYS ("back to the two screens" — the
  // operator's ruling on the only session); the old menu landing retires.
  check('C1 releasing the LAST row rests the slot and the board stays (no menu bounce) — no ghost minted at the screen\'s cwd', removeBody.includes('if (!repointed) slot.releaseFocusedSessionConnector()') && !removeBody.includes('enterBootSettings()') && !removeBody.includes('focusNascentSession') && !removeBody.includes('getMainLoopModel'))
  const repl = read('src/screens/REPL.tsx')
  const backstopAt = repl.indexOf('// NO CHAT ⇒ THE BOOT MENU (Law 9, rule 5)')
  const backstopEnd = repl.indexOf('}, [slotHasSession, landing, replSurfaceCovered, localJsx, armedMessage]);', backstopAt)
  const backstop = backstopAt !== -1 && backstopEnd !== -1 ? repl.slice(backstopAt, backstopEnd) : ''
  // The REPL's yield is the
  // road OUT of a chat-less REPL; the landing itself is the router's ONE
  // owner (settleAbsentChat — the boot menu with nothing beneath to return
  // to), and the router's home/strip verbs never route INTO an absent chat.
  check('C2 the root REPL yields whenever it would front a resting slot, handing the frame to the router\'s one absent-chat landing (settleAbsentChat, never a return token onto the empty chat)', backstop !== '' && backstop.includes('settleAbsentChat()') && !backstop.includes('enterBootSettings()') && backstop.includes('hasFocusedSession()'))
  check('C2 the yield settles one beat and re-reads every fact at fire time (a mounting dialog is never buried)', backstop.includes('NO_CHAT_SETTLE_MS') && backstop.includes("currentSurfaceRoute().kind !== 'repl'") && backstop.includes('toolJSXRef.current?.isLocalJSXCommand === true'))
  check('C2 an inline boot keeps its REPL (CB-10: no frame for the face)', backstop.includes('if (!isFullscreenEnvEnabled()) return;'))
  const route = read('src/context/surfaceRoute.ts')
  // Re-pinned: the armed form RETIRED with the face's
  // last armed row — the home verb refuses without a chat, full stop; the
  // argv-prompt boot mounts the chat route through the resolver's
  // explicit-journey landing, never this verb.
  check('C2 the router\'s home verb never routes into an absent chat (no chat ⇒ no movement, no armed exception left)', route.includes('export function enterRootRepl(): ChatEntry {') && route.includes('if (!chatPresent()) {') && route.includes("return { ok: false, code: 'no-chat', reason: NO_CHAT_HINT }") && !route.includes('armedRootCommand'))
  const face = read('src/components/BootSplashScreen.tsx')
  // Re-pinned (the operator's face-native ruling):
  // Doctor and Resume open face-native layers; New Session, Projects and
  // now Continue enter the chat they birthed or resumed through the plain
  // form — the armed form is GONE from the face entirely.
  check('C2 no face row arms a root command; Doctor/Resume open face layers; New Session, Projects and Continue enter the chat they birthed or resumed', (face.match(/enterRootRepl\(\{ armedRootCommand: true \}\)/g) ?? []).length === 0 && (face.match(/enterRootRepl\(\)/g) ?? []).length === 5 && face.includes('setHealthOpen(true)') && face.includes('setResumeOpen(true)') && !face.includes('armRootCommand'))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  const clearAt = hop.indexOf('export async function clearFocusedSession(')
  const clearBody = hop.slice(clearAt)
  check('C3 /clear with no chat open clears nothing', clearBody.includes('if (!slot.hasFocusedSession()) return { ok: true, cleared: false }'))
  // Re-trued to the landed order (the park-then-birth law RETIRED with its
  // reason: the release dropped the frame before the birth's landing gate
  // armed, so the plain world mounted the Boot face mid-swap): /clear
  // births FIRST — the born hop swaps the slot straight onto the fresh
  // chat — then parks the OLD session by id (action 'park', never a
  // release); a failed birth moves NOTHING and the old chat stays focused,
  // with the daemon's own sentence riding the refusal.
  check('C3 /clear births the fresh chat FIRST, then parks the old one by id (a failed birth moves nothing; never a release)', clearBody.indexOf('bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })') !== -1 && clearBody.indexOf('bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })') < clearBody.indexOf('parkSessionById(oldSessionId)') && !clearBody.includes("op: 'sessionRelease'"))
  check('C3 a refused birth leaves the OLD chat standing, the daemon\'s own sentence in the refusal', clearBody.includes('a fresh session could not start, so this one stands'))
  const command = read('src/commands/clear/clear.ts')
  check('C3 the /clear command rides the one door', command.includes('clearFocusedSession()'))

  // ── C3s: THE SEAT-SWAP (operator-sighted, ruled) ──────────
  // The births-first order collided with a FULL seat world: both seats
  // held, the birth demanded a THIRD, refusal guaranteed — /clear could
  // never work at capacity. The ruled fix: /clear counts its own seat as
  // leaving. The swap math runs through the PURE admission core (the red
  // control first — the sighting reproduced), and the threading pins hold
  // the road: /clear → bornSession → wire → the handler's exclusion.
  {
    // Hermetic config ground: the refusal sentence composes the consented
    // seat reading through the global config — a scratch home, enabled.
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: joinPath } = await import('node:path')
    process.env.MERCURY_CONFIG_DIR = mkdtempSync(joinPath(tmpdir(), 'one-door-swap-'))
    const { enableConfigs } = await import('../../src/utils/config.js')
    enableConfigs()
    const { evaluateConcourseAdmission } = await import('../../src/daemon/concourseSupervisor.ts')
    const seatA = { workspaceId: '/w/alpha', isolation: 'shared' as const }
    const seatB = { workspaceId: '/w/beta', isolation: 'shared' as const }
    const birth = { workspaceId: '/w/alpha', isolation: 'shared' as const }
    const full = evaluateConcourseAdmission([seatA, seatB], birth, 2)
    check('C3s RED CONTROL: a full 2-seat world refuses a plain birth on the capacity code (the sighting)', full.admit === false && (full as { code?: string }).code === 'runtime-ceiling')
    const swapped = evaluateConcourseAdmission([seatB], birth, 2)
    check('C3s the SAME world minus the vacating seat ADMITS — the birth rides the seat /clear vacates', swapped.admit === true)
    const sup = read('src/daemon/concourseSupervisor.ts')
    check('C3s the admit handler excludes exactly the vacating claim from the fold (call-shaped)', sup.includes('r.sessionId !== req.vacatingSessionId'))
    const server = read('src/daemon/controlServer.ts')
    check('C3s the wire narrows the hint and forwards it (a stale hint is the host\'s inert case, never a wire refusal)', server.includes("typeof raw.vacatingSessionId === 'string' && raw.vacatingSessionId !== ''"))
    const born = read('src/services/switchboard/bornSession.ts')
    check('C3s bornSession carries the hint onto the admit op', born.includes('vacatingSessionId: req.vacatingSessionId'))
    const dispatch = read('src/daemon/concourseDispatch.ts')
    check('C3s POISON: the held-op envelope never carries the swap hint (a held replay must not exclude a seat from a moved-on world)', !dispatch.includes('vacatingSessionId'))
  }
}

// ── F: the flags ────────────────────────────────────────────────────────────
console.log('F — the two switches (the amendment)')
{
  const { normalizeBankedFlagSpellings, applyBankedFlagSpellings, BANKED_FLAG_SPELLINGS } = await import('../../src/substrate/argvSpellings.ts')
  check('F1 the banked spellings admit as the estate\'s forms', JSON.stringify(normalizeBankedFlagSpellings(['-chat', '-concourse-off', '-concourse-on'])) === JSON.stringify(['--chat', '--concourse-off', '--concourse-on']))
  check('F1 exact tokens only: -c stays --continue\'s short, -chatty and --chat are untouched', JSON.stringify(normalizeBankedFlagSpellings(['-c', '-chatty', '--chat', 'words'])) === JSON.stringify(['-c', '-chatty', '--chat', 'words']))
  check('F1 the -- sentinel ends the rewrite (an operand spelled -chat after it is the operand)', JSON.stringify(normalizeBankedFlagSpellings(['-chat', '--', '-chat'])) === JSON.stringify(['--chat', '--', '-chat']))
  const argv = ['node', 'mercury.mjs', '-chat', '-n', 'x']
  applyBankedFlagSpellings(argv)
  check('F1 the in-place apply keeps the binary and the script and rewrites the rest', JSON.stringify(argv) === JSON.stringify(['node', 'mercury.mjs', '--chat', '-n', 'x']))
  // The dependency refresh (commander 15): the operator's short debug flag
  // `-d2e` admits as its canonical `--d2e` through the same pass, from its
  // OWN table — the banked table stays the three words below.
  const { DEBUG_FLAG_SPELLINGS } = await import('../../src/substrate/argvSpellings.ts')
  check('F1 the operator\'s -d2e admits as --d2e from its own table (exact token; -d2ex untouched; the banked table does not carry it)', JSON.stringify(normalizeBankedFlagSpellings(['-d2e', '-d2ex', '--', '-d2e'], DEBUG_FLAG_SPELLINGS)) === JSON.stringify(['--d2e', '-d2ex', '--', '-d2e']) && !('-d2e' in BANKED_FLAG_SPELLINGS) && read('src/entrypoints/cli.tsx').includes('applyBankedFlagSpellings(process.argv, DEBUG_FLAG_SPELLINGS)'))
  check('F1 the table names exactly the three banked spellings', Object.keys(BANKED_FLAG_SPELLINGS).sort().join(',') === '-chat,-concourse-off,-concourse-on')
  const cli = read('src/entrypoints/cli.tsx')
  check('F1 the cli entry applies the spellings BEFORE commander and after the splash handover', cli.indexOf('consumeSplashHandover()') !== -1 && cli.indexOf('applyBankedFlagSpellings(process.argv)') > cli.indexOf('consumeSplashHandover()') && cli.indexOf('applyBankedFlagSpellings(process.argv)') !== -1 && cli.indexOf('applyBankedFlagSpellings(process.argv)') < cli.indexOf('// 5 — the V8 compile cache'))
  const main = read('src/main.tsx')
  check('F2 the three options exist in the estate\'s grammar with their help naming the banked spellings', main.includes(".option('--chat',") && main.includes(".option('--concourse-off',") && main.includes(".option('--concourse-on',") && main.includes('`-chat` is the same switch') && main.includes('`-concourse-off` is the same switch'))
  // L15 (the operator's word): `--chat` BOOTS ON THE BOOT MENU — not an
  // explicit journey, no session born at boot; ↵ New Session is the door.
  // Only words on argv and an inline boot birth at boot.
  check('F2 --chat lands on the boot menu (L15): not an explicit journey, no birth at boot — words and an inline boot still birth', main.includes('if (opts.continue || opts.resume || opts.fromPr || inputPrompt) {') && main.includes('if (promptIsWords || !isFullscreenEnvEnabled()) {') && main.includes("bornSession({ workspaceDir: getCwd(), model: null })") && !main.includes('opts.chat === true || promptIsWords') && !main.includes('program.opts().chat === true'))
  // `--chat` is THE PLAIN
  // WORLD for its boot — the router reads the mark (and the persisted
  // switch) as the one chat-only fact; the strip drops the concourse stop
  // (prove-surface-strip §4 walks it). No third flag exists.
  check('F2 --chat marks the plain world at launch classification (markChatBoot beside the explicit-journey mark; no third flag)', /if \(opts\.chat === true\) \{[\s\S]*?markChatBoot\(\)/.test(main) && !main.includes("'--chat-only'") && !main.includes('chatOnly:'))
  check('F2 a slash line on argv (the Doctor splice) births nothing — only words do', main.includes("!inputPrompt.trimStart().startsWith('/')"))
  // The persisted field: set → read → survives a re-read from disk in a
  // FRESH process (the restart half of "survives restart"; the built
  // artifact's restart drive lives in prove-one-door-drive.ts).
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { concourseEnabled, setConcourseEnabled } = await import('../../src/services/concourse/concourseEnabled.ts')
  check('F3 DEFAULT ON: a fresh home boots WITH the concourse', concourseEnabled() === true)
  setConcourseEnabled(false)
  check('F3 --concourse-off sets the field off', concourseEnabled() === false)
  const configPath = join(process.env.MERCURY_CONFIG_DIR!, '.mercury.json')
  const bytes = readFileSync(configPath, 'utf8')
  check('F3 the field is PERSISTED under its registered name', /"concourseEnabled"\s*:\s*false/.test(bytes))
  const child = Bun.spawnSync({
    cmd: [process.execPath, '-e', "const m = await import('./src/services/concourse/concourseEnabled.ts'); const c = await import('./src/utils/config.js'); c.enableConfigs(); console.log(String(m.concourseEnabled()))"],
    cwd: process.cwd(),
    env: { ...process.env, MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR! },
  })
  check('F3 the OFF state survives a fresh process (re-read from disk — the restart half)', child.stdout.toString().trim() === 'false', child.stderr.toString().slice(-200))
  setConcourseEnabled(true)
  check('F3 the symmetric re-enable turns it back on (off is never a one-way door)', concourseEnabled() === true)
  const before = readFileSync(configPath, 'utf8')
  concourseEnabled()
  concourseEnabled()
  check('F3 SET, never heal-repainted: reads write nothing back', readFileSync(configPath, 'utf8') === before)
  const schema = read('src/utils/config/schema.ts')
  check('F3 the field is REGISTERED in the config schema and the key list', schema.includes('concourseEnabled?: boolean') && schema.includes("'concourseEnabled',"))
  const settings = read('src/components/Settings/Config.tsx')
  check('F3 /config carries the row (the other writer)', settings.includes("id: 'concourse'") && settings.includes('concourseEnabled: next'))
  check('F3 the boot switch writes through the one door, the later switch winning', main.includes("setConcourseEnabled(lastSwitch === '--concourse-on')"))
  const route = read('src/context/surfaceRoute.ts')
  // The policy is gated on
  // the CONCOURSE STOP's existence — off when the switch is off OR the boot
  // is `--chat` (the plain world) — so a `--chat` boot under a policy-always
  // env still lands the chat.
  check("F4 with the concourse off (or a --chat boot) the boot never auto-enters it (the policy reads 'off' when the concourse stop is absent)", route.includes("const policy = stripStops(stripFacts()).includes('concourse') ? resolveConcoursePolicy(opts.env) : 'off'"))
  const concourseRoute = read('src/components/concourse/ConcourseRoute.tsx')
  // Rule 5's "with the concourse
  // off, shift+→ still shows a plain live view" sentence was a
  // readback, never the operator's words ("turns it off for all future
  // mercury sessions"; "no concourse in the middle at all") — the strip
  // carries no concourse stop in that world. The reduced stage stays the
  // switched-off concourse's SCREEN, reached through its explicit doors
  // alone (the face's row, /concourse, ctrl+x c, 'o').
  // The world-fact fix (ruled): the reduced
  // stage is THE PLAIN WORLD's — the switch off OR a `--chat` boot — read
  // from the router's one fact; a `--chat` boot with the switch on had
  // opened the full coordinator board through every explicit door.
  check('F4 the concourse route renders the reduced stage in the plain world — the switch off OR a --chat boot (the router\'s one world fact; the plain live view behind the explicit doors — never a strip stop)', concourseRoute.includes('reducedStage={chatOnlyBoot()}') && !concourseRoute.includes('reducedStage={!concourseEnabled()}') && !concourseRoute.includes("from '../../services/concourse/concourseEnabled.js'"))
  check('F4 no reader promises a shift+→ live view any more (the retired rule-5 sentence)', !/shift\+→[^\n]*live view|live view[^\n]*shift\+→/i.test(read('src/services/concourse/concourseEnabled.ts') + read('src/main.tsx') + read('src/context/surfaceRoute.ts') + read('src/components/BootSplashScreen.tsx')))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('F4 the reduced stage keeps the rows and the live view and drops the coordinator panel (the two-composers ring)', screen.includes("reducedStage ? ['list', 'live'] : ['coordinator', 'list', 'live']"))
  // Re-cut at the two-composers split: 'send' became sendLive
  // (the live pane's steering box) and sendCoordinator (the coordinator's
  // own) — BOTH doors open with the reduced-stage guard.
  check('F4 the reduced stage types nothing into a composer (no draft, no dispatch — both send doors guarded)', screen.includes('if (reducedStage) return') && /const sendLive = \(\): void => \{\n    if \(reducedStage\) return/.test(screen) && /const sendCoordinator = \(\): void => \{\n    if \(reducedStage\) return/.test(screen))
  check('F4 the reduced stage says why this boot is the plain world and the way back in the router\'s words (a --chat boot with the switch on is never told to turn it on)', screen.includes('{concourseWayBack()}') && screen.includes('plainWorldWhy()') && !screen.includes('--concourse-on or /config turns the coordinator on'))
  const face = read('src/components/BootSplashScreen.tsx')
  // Re-cut at the boot-face indicator: the projects prop maps
  // the picker rows (running counts aboard) — the un-dimmed law is the
  // projectsDim ABSENCE, unchanged.
  check('F5 B1: the boot menu keeps Projects un-dimmed with the concourse off (the face passes no projectsDim)', face.includes('projects={facts.pickerProjects.map(p => {') && !face.includes('projectsDim'))
  check('F5 the concourse row stays enterable with the switch off and says what it is (live view only)', face.includes('live view only — concourse off'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-one-door-lifecycle: ALL LAWS HOLD' : `\nprove-one-door-lifecycle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
