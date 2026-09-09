#!/usr/bin/env bun
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

console.log('R — resume brings up the whole house (rule 3)')
{
  const main = read('src/main.tsx')
  const resumeAt = main.indexOf('const resumeAtBoot = async')
  const resumeBody = resumeAt !== -1 ? main.slice(resumeAt, main.indexOf('if (opts.continue) {', resumeAt)) : ''
  check('R1 --continue / --resume <id> ride the ONE resume path at boot', resumeBody.includes('focusResumedSession(sessionId, log.fullPath'))
  check('R1 the boot resume carries the resolved posture (parity with a birth)', resumeBody.includes('permissionMode: args.permissionMode'))
  const face = read('src/components/BootSplashScreen.tsx')
  check('R1 Boot › Continue rides the ONE resume path directly with the resolved posture', face.includes('focusResumedSession(sid, target.transcriptPath ?? undefined') && face.includes('permissionMode: permissionModeRef.current'))
  check('R1 Projects-↵ rides the ONE resume path with the row transcript', face.includes('focusResumedSession(p.sessionId, p.transcriptPath'))
  const repl = read('src/screens/REPL.tsx')
  const mountAt = repl.indexOf('// ── boot-time work (mount once; nothing here may touch the paint path) ──')
  const mountEnd = repl.indexOf("// The local model servers' discovery", mountAt)
  check('R2 the mount block is found whole (both markers present, in order)', mountAt !== -1 && mountEnd > mountAt)
  const mountBody = repl.slice(mountAt, mountEnd)
  check('R2 every landing can start its daemon without requesting a worker', mountBody.includes('ensureOwnedDaemon()') && !mountBody.includes('warmSessionRunner(getCwd())') && !/if \(.*(resume|continue|journey)/i.test(mountBody))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  const fnAt = hop.indexOf('export function focusResumedSession(')
  const fnBody = hop.slice(fnAt, hop.indexOf('async function paintResumeRecap', fnAt))
  check('R3 a session live on the board is ENTERED (a hop — nothing respawns); a durable one is admitted behind its paint', fnAt !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') < fnBody.indexOf("op: 'sessionAdmit'") && fnBody.includes('resumeSessionId: sessionId'))
  check('R4 the resume boots are explicit journeys (the chat is the landing, the menu one shift away) — and --chat is NOT one of them (L15)', main.includes('if (opts.continue || opts.resume || opts.fromPr || inputPrompt) {') && main.includes('markExplicitBootJourney()') && !main.includes('inputPrompt || opts.chat === true) {') && main.includes('`--chat`\n    // is NOT one of them: it lands on the boot face like a bare boot (L15).'))
  const route = read('src/context/surfaceRoute.ts')
  check('R5 switching unchanged: the strip keeps [boot menu · concourse · chat] in order, the chat stop counted from the focused slot (the reserved third stop retires)', route.includes("export const STRIP_ORDER: readonly StripStop[] = ['boot-settings', 'concourse', 'repl']") && route.includes("if (facts.chatPresent) stops.push('repl')") && !route.includes("const order = ['repl', 'concourse', 'boot-settings'] as const"))
}

console.log('C — close all chats ⇒ the boot menu (rule 5)')
{
  const board = read('src/components/concourse/ConcourseRoute.tsx')
  const removeAt = board.indexOf('removeSession: sessionId => {')
  const removeBody = board.slice(removeAt, board.indexOf('noteControl(\n              \'strip:composer\',\n              reply.ok === true && reply.settled !== false', removeAt))
  check('C1 releasing the focused row re-points at a SURVIVOR first (the reaped-session ghost stays closed)', removeBody.includes('hops.hopIntoBoardSession(next.sessionId)'))
  check('C1 releasing the LAST row rests the slot and the board stays (no menu bounce) — no ghost minted at the screen\'s cwd', removeBody.includes('if (!repointed) slot.releaseFocusedSessionConnector()') && !removeBody.includes('enterBootSettings()') && !removeBody.includes('focusNascentSession') && !removeBody.includes('getMainLoopModel'))
  const repl = read('src/screens/REPL.tsx')
  const backstopAt = repl.indexOf('// NO CHAT ⇒ THE BOOT MENU (Law 9, rule 5)')
  const backstopEnd = repl.indexOf('}, [slotHasSession, landing, replSurfaceCovered, localJsx, armedMessage]);', backstopAt)
  const backstop = backstopAt !== -1 && backstopEnd !== -1 ? repl.slice(backstopAt, backstopEnd) : ''
  check('C2 the root REPL yields whenever it would front a resting slot, handing the frame to the router\'s one absent-chat landing (settleAbsentChat, never a return token onto the empty chat)', backstop !== '' && backstop.includes('settleAbsentChat()') && !backstop.includes('enterBootSettings()') && backstop.includes('hasFocusedSession()'))
  check('C2 the yield settles one beat and re-reads every fact at fire time (a mounting dialog is never buried)', backstop.includes('NO_CHAT_SETTLE_MS') && backstop.includes("currentSurfaceRoute().kind !== 'repl'") && backstop.includes('toolJSXRef.current?.isLocalJSXCommand === true'))
  check('C2 an inline boot keeps its REPL (CB-10: no frame for the face)', backstop.includes('if (!isFullscreenEnvEnabled()) return;'))
  const route = read('src/context/surfaceRoute.ts')
  check('C2 the router\'s home verb never routes into an absent chat (no chat ⇒ no movement, no armed exception left)', route.includes('export function enterRootRepl(): ChatEntry {') && route.includes('if (!chatPresent()) {') && route.includes("return { ok: false, code: 'no-chat', reason: NO_CHAT_HINT }") && !route.includes('armedRootCommand'))
  const face = read('src/components/BootSplashScreen.tsx')
  check('C2 no face row arms a root command; Doctor/Resume open face layers; New Session, Projects and Continue enter the chat they birthed or resumed', (face.match(/enterRootRepl\(\{ armedRootCommand: true \}\)/g) ?? []).length === 0 && (face.match(/enterRootRepl\(\)/g) ?? []).length === 5 && face.includes('setHealthOpen(true)') && face.includes('setResumeOpen(true)') && !face.includes('armRootCommand'))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  const clearAt = hop.indexOf('export async function clearFocusedSession(')
  const clearBody = hop.slice(clearAt)
  check('C3 /clear with no chat open clears nothing', clearBody.includes('if (!slot.hasFocusedSession()) return { ok: true, cleared: false }'))
  check('C3 /clear births the fresh chat FIRST, then parks the old one by id (a failed birth moves nothing; never a release)', clearBody.indexOf('bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })') !== -1 && clearBody.indexOf('bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })') < clearBody.indexOf('parkSessionById(oldSessionId)') && !clearBody.includes("op: 'sessionRelease'"))
  check('C3 a refused birth leaves the OLD chat standing, the daemon\'s own sentence in the refusal', clearBody.includes('a fresh session could not start, so this one stands'))
  const command = read('src/commands/clear/clear.ts')
  check('C3 the /clear command rides the one door', command.includes('clearFocusedSession()'))

  {
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

console.log('F — the two switches (the amendment)')
{
  const { normalizeBankedFlagSpellings, applyBankedFlagSpellings, BANKED_FLAG_SPELLINGS } = await import('../../src/substrate/argvSpellings.ts')
  check('F1 the banked spellings admit as the estate\'s forms', JSON.stringify(normalizeBankedFlagSpellings(['-chat', '-concourse-off', '-concourse-on'])) === JSON.stringify(['--chat', '--concourse-off', '--concourse-on']))
  check('F1 exact tokens only: -c stays --continue\'s short, -chatty and --chat are untouched', JSON.stringify(normalizeBankedFlagSpellings(['-c', '-chatty', '--chat', 'words'])) === JSON.stringify(['-c', '-chatty', '--chat', 'words']))
  check('F1 the -- sentinel ends the rewrite (an operand spelled -chat after it is the operand)', JSON.stringify(normalizeBankedFlagSpellings(['-chat', '--', '-chat'])) === JSON.stringify(['--chat', '--', '-chat']))
  const argv = ['node', 'mercury.mjs', '-chat', '-n', 'x']
  applyBankedFlagSpellings(argv)
  check('F1 the in-place apply keeps the binary and the script and rewrites the rest', JSON.stringify(argv) === JSON.stringify(['node', 'mercury.mjs', '--chat', '-n', 'x']))
  const { DEBUG_FLAG_SPELLINGS } = await import('../../src/substrate/argvSpellings.ts')
  check('F1 the operator\'s -d2e admits as --d2e from its own table (exact token; -d2ex untouched; the banked table does not carry it)', JSON.stringify(normalizeBankedFlagSpellings(['-d2e', '-d2ex', '--', '-d2e'], DEBUG_FLAG_SPELLINGS)) === JSON.stringify(['--d2e', '-d2ex', '--', '-d2e']) && !('-d2e' in BANKED_FLAG_SPELLINGS) && read('src/entrypoints/cli.tsx').includes('applyBankedFlagSpellings(process.argv, DEBUG_FLAG_SPELLINGS)'))
  check('F1 the table names exactly the three banked spellings', Object.keys(BANKED_FLAG_SPELLINGS).sort().join(',') === '-chat,-concourse-off,-concourse-on')
  const cli = read('src/entrypoints/cli.tsx')
  check('F1 the cli entry applies the spellings BEFORE commander and after the splash handover', cli.indexOf('consumeSplashHandover()') !== -1 && cli.indexOf('applyBankedFlagSpellings(process.argv)') > cli.indexOf('consumeSplashHandover()') && cli.indexOf('applyBankedFlagSpellings(process.argv)') !== -1 && cli.indexOf('applyBankedFlagSpellings(process.argv)') < cli.indexOf('// 5 — the V8 compile cache'))
  const main = read('src/main.tsx')
  check('F2 the three options exist in the estate\'s grammar with their help naming the banked spellings', main.includes(".option('--chat',") && main.includes(".option('--concourse-off',") && main.includes(".option('--concourse-on',") && main.includes('`-chat` is the same switch') && main.includes('`-concourse-off` is the same switch'))
  check('F2 --chat lands on the boot menu (L15): not an explicit journey, no birth at boot — words and an inline boot still birth', main.includes('if (opts.continue || opts.resume || opts.fromPr || inputPrompt) {') && main.includes('if (promptIsWords || !isFullscreenEnvEnabled()) {') && main.includes("bornSession({ workspaceDir: getCwd(), model: null })") && !main.includes('opts.chat === true || promptIsWords') && !main.includes('program.opts().chat === true'))
  check('F2 --chat marks the plain world at launch classification (markChatBoot beside the explicit-journey mark; no third flag)', /if \(opts\.chat === true\) \{[\s\S]*?markChatBoot\(\)/.test(main) && !main.includes("'--chat-only'") && !main.includes('chatOnly:'))
  check('F2 a slash line on argv (the Doctor splice) births nothing — only words do', main.includes("!inputPrompt.trimStart().startsWith('/')"))
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
  check("F4 with the concourse off (or a --chat boot) the boot never auto-enters it (the policy reads 'off' when the concourse stop is absent)", route.includes("const policy = stripStops(stripFacts()).includes('concourse') ? resolveConcoursePolicy(opts.env) : 'off'"))
  const concourseRoute = read('src/components/concourse/ConcourseRoute.tsx')
  check('F4 the concourse route renders the reduced stage in the plain world — the switch off OR a --chat boot (the router\'s one world fact; the plain live view behind the explicit doors — never a strip stop)', concourseRoute.includes('reducedStage={chatOnlyBoot()}') && !concourseRoute.includes('reducedStage={!concourseEnabled()}') && !concourseRoute.includes("from '../../services/concourse/concourseEnabled.js'"))
  check('F4 no reader promises a shift+→ live view any more (the retired rule-5 sentence)', !/shift\+→[^\n]*live view|live view[^\n]*shift\+→/i.test(read('src/services/concourse/concourseEnabled.ts') + read('src/main.tsx') + read('src/context/surfaceRoute.ts') + read('src/components/BootSplashScreen.tsx')))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('F4 the reduced stage keeps the rows and the live view and drops the coordinator panel (the two-composers ring)', screen.includes("reducedStage ? ['list', 'live'] : ['coordinator', 'list', 'live']"))
  check('F4 the reduced stage types nothing into a composer (no draft, no dispatch — both send doors guarded)', screen.includes('if (reducedStage) return') && /const sendLive = \(\): void => \{\n    if \(reducedStage\) return/.test(screen) && /const sendCoordinator = \(\): void => \{\n    if \(reducedStage\) return/.test(screen))
  check('F4 the reduced stage says why this boot is the plain world and the way back in the router\'s words (a --chat boot with the switch on is never told to turn it on)', screen.includes('{concourseWayBack()}') && screen.includes('plainWorldWhy()') && !screen.includes('--concourse-on or /config turns the coordinator on'))
  const face = read('src/components/BootSplashScreen.tsx')
  check('F5 B1: the boot menu keeps Projects un-dimmed with the concourse off (the face passes no projectsDim)', face.includes('projects={facts.pickerProjects.map(p => {') && !face.includes('projectsDim'))
  check('F5 the concourse row stays enterable with the switch off and says what it is (live view only)', face.includes('live view only — concourse off'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-one-door-lifecycle: ALL LAWS HOLD' : `\nprove-one-door-lifecycle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
