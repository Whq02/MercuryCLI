#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-seat-lifecycle.ts — the session lifecycle at the
//  SOURCE seams plus the resting slot's pure laws. One kind of session exists
//  — the concourse-managed kind — and under the ONE-DOOR LAW (Law 9: the
//  session is the unit; every screen is a view) a chat exists only once a
//  session does: the slot RESTS on no session until one is entered. (The
//  driven halves live in the capture drives and the seat journeys; this
//  prover owns the boot/resume/birth seams because the switchboard suite
//  owns every other seat law — the boot face and the resume path are its
//  callers, not its owners.)
//
//  THE ONE-DOOR REWRITE: the earlier
//  line "Boot › New Session ENTERS the seeded blank chat" is retired
//  BY NAME here — P2 now pins create-on-Enter (born = registered), P3 the
//  resting slot's honest empties and the birth door, P4 that the slot rests
//  on NO session by default. Never a silent revert.
//
//   P1  ONE resume path: the REPL's resume() re-points the focused slot
//       through focusResumedSession and mutates no session state of its own
//       (no switchSession, no session-end hooks, no file-pointer move); a
//       session live on the board is entered first (a hop — nothing resumes,
//       nothing respawns), a durable one is admitted as a managed session
//       behind its first paint;
//   P2  Boot › New Session BIRTHS a real session through the ONE birth door
//       and enters it — no ghost is handed to the slot, no engine is handed
//       back, no armed /clear;
//   P3  the resting slot owns NO session: blank records, idle, zero usage,
//       every send refused with the door a chat starts through; the birth
//       door admits through the daemon's admit op carrying the model shown
//       and the boot's facts, then hops (source pin);
//   P4  the focused slot rests on NO session by default and closes back to
//       resting; no ghost spelling survives in the product tree;
//   P5  the resumed seat's recap is display-only (the same builder, gated
//       by the same setting, painted as a row the writer never records).
// ============================================================================
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'seat-lifecycle-'))
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

/** Every .ts/.tsx under a root (the kill-list completeness walk). */
function walk(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const p = join(root, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

// ── P1: the one resume path ─────────────────────────────────────────────────
{
  const repl = read('src/screens/REPL.tsx')
  const resumeAt = repl.indexOf('const resume = useCallback(')
  const resumeBody = repl.slice(resumeAt, repl.indexOf('resumeRef.current = resume', resumeAt))
  check('P1 resume() re-points the slot through the one resume path', resumeBody.includes('focusResumedSession('))
  check(
    'P1 resume() mutates no session state of its own (no switch, no hooks, no pointer move)',
    !resumeBody.includes('switchSession(') && !resumeBody.includes('executeSessionEndHooks(') && !resumeBody.includes('resetSessionFilePointer('),
  )
  check('P1 resume() keeps the composer where it was (no draft flush)', !resumeBody.includes('flushDrafts('))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  // The one resume door is SYNC (the landing wrapper owns the
  // async body) — the slice anchors on the landing, with its own presence
  // tooth so a moved spelling reds loud instead of blanking every needle.
  const fnAt = hop.indexOf('async function focusResumedSessionLanding(')
  const fnBody = hop.slice(fnAt, hop.indexOf('async function paintResumeRecap', fnAt))
  check('P1 the resume landing body is anchored (the slice cannot go vacuous)', fnAt !== -1 && hop.indexOf('async function paintResumeRecap', fnAt) > fnAt)
  check('P1 a session live on the board is ENTERED before any admission', fnBody.indexOf('sessionOwnedByLiveWorker(') !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') < fnBody.indexOf("op: 'sessionAdmit'"))
  check('P1 a durable session is admitted as a MANAGED session (--resume) behind its paint', fnBody.includes('resumeSessionId: sessionId') && fnBody.includes('awaitAdmission('))
  check('P1 the transcript paints from its file before the route flips (the flicker law)', fnBody.includes('focusDaemonSession(connector.record)') && fnBody.indexOf('focusDaemonSession(connector.record)') > fnBody.indexOf('awaitAdmission('))
  check('P1 no other resume spelling survives in the tree', !hop.includes('resumeSessionOnConcourse') && !repl.includes('resumeSessionOnConcourse'))
}

// ── P2: the boot face's New Session — CREATE-ON-ENTER ───────────────────────
// Poison = the retired ENTERED law: a ↵ that handed the slot a blank chat
// (focusNascentSession) and created nothing.
{
  const boot = read('src/components/BootSplashScreen.tsx')
  const newAt = boot.indexOf("case 'new': {")
  const newBody = boot.slice(newAt, boot.indexOf("case 'continue'", newAt))
  // The door stopped passing a model at L18: the birth reads the
  // next-session facts' choice, else the screen's main — inside bornSession
  // (birthModelOf), never at the call site.
  check('P2 New Session births a real session through the ONE birth door', newBody.includes('bornSession({ workspaceDir: process.cwd() })'))
  check('P2 the chat is entered only once the birth succeeded (a refusal paints its reason, enters nothing)', newBody.indexOf('if (!born.ok) return born.reason') !== -1 && newBody.indexOf('if (!born.ok) return born.reason') < newBody.indexOf('enterRootRepl()'))
  check('P2 no ghost is handed to the slot (the ENTERED law is gone)', !newBody.includes('focusNascentSession') && !newBody.includes('isNascentConnector'))
  check('P2 nothing is handed back to an engine and no /clear is armed', !boot.includes('focusInProcessSession') && !newBody.includes("armRootCommand('/clear')"))
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  check('P2 the in-process hand-back verb is gone from the hop owner', !hop.includes('focusInProcessSession'))
  check('P2 the ghost mint door is gone from the hop owner', !hop.includes('focusNascentSession'))
}

// ── P3: the resting slot's pure laws + the birth door ───────────────────────
{
  const { NoSessionConnector, NO_CHAT_OPEN } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  const resting = new NoSessionConnector()
  // The queue doors DIED with the operator-facing holding pen (the delivery
  // law — types.ts says so at the contract): the resting-slot pin follows
  // the retirement; a revived queue door must bring its own re-true.
  check('P3 the resting slot is daemon-carried and blank', resting.carrier === 'daemon' && resting.records().length === 0)
  check('P3 nothing runs and nothing is pending', resting.turnActive() === false && resting.asks().length === 0 && resting.interrupt() === false)
  check('P3 the usage is honest zeros', resting.usage().totalCostUSD === 0 && resting.usage().totalInputTokens === 0)
  check('P3 no session — the empty id', resting.sessionId() === '')
  const send = await resting.sendWords('hello')
  check('P3 a send is refused with the door a chat starts through (poison: a send that creates a session)', send.state === 'refused' && send.detail === NO_CHAT_OPEN && /New Session/.test(NO_CHAT_OPEN))
  const slash = await resting.dispatchSlash('/cost')
  check('P3 a slash line is refused the same way (no surprise birth from a command line)', slash.state === 'refused' && slash.detail === NO_CHAT_OPEN)
  check('P3 a model switch is refused (nothing to switch)', (await resting.setModel('claude-sonnet-5')).state === 'refused')
  const ask = await resting.answerAsk()
  check('P3 an ask answer is refused (no asks exist)', ask.ok === false)
  // The uSES-snapshot law: every reader door answers a STABLE identity. A
  // fresh [] / {…} per call re-rendered forever (React error 185).
  check(
    'P3 the reader doors answer stable snapshots (records/asks/modelFacts/usage/identity/skills/mcp/workspace/work)',
    resting.records() === resting.records() &&
      resting.asks() === resting.asks() &&
      resting.modelFacts() === resting.modelFacts() &&
      resting.usage() === resting.usage() &&
      resting.identity() === resting.identity() &&
      resting.skillsRoster() === resting.skillsRoster() &&
      resting.mcpRoster() === resting.mcpRoster() &&
      resting.workspace() === resting.workspace() &&
      resting.workRoster() === resting.workRoster(),
  )
  const src = read('src/services/switchboard/bornSession.ts')
  // bornSession became the sync single-flight door (the ↵↵ double-birth
  // guard); the async body moved into birth(). Anchor there, with a presence
  // tooth so a moved spelling reds loud instead of blanking every needle —
  // AND turning the "sends NO words" negative below vacuous-green.
  const fnAt = src.indexOf('async function birth(')
  const body = src.slice(fnAt)
  check('P3 the birth body is anchored (the slice cannot go vacuous)', fnAt !== -1)
  check('P3 the birth door admits through the daemon (born = registered) and then hops', body.includes("op: 'sessionAdmit'") && body.indexOf("op: 'sessionAdmit'") < body.indexOf('hopIntoBoardSession(sessionId'))
  check('P3 the birth is marked blank for the daemon (the birth grace reads it)', body.includes('bornBlank: true'))
  check('P3 the birth carries the model shown, the title, the effort, the posture and the runner options', body.includes('model,') && body.includes('{ title }') && body.includes('effort: facts.effort') && body.includes('permissionMode: facts.permissionMode') && body.includes('runnerArgv: [...facts.runnerArgv]'))
  check('P3 the birth sends NO words (a blank, ready session — never a dispatch)', !body.includes("op: 'sessionDispatch'") && !body.includes('prompt:'))
  check('P3 the daemon heals before the birth (the first Enter never meets ENOENT)', body.indexOf('ensureOwnedDaemon()') !== -1 && body.indexOf('ensureOwnedDaemon()') < body.indexOf("op: 'sessionAdmit'"))
}

// ── P4: the slot rests on NO session ────────────────────────────────────────
// Poison = the retired slot default: a lazily minted blank chat for the boot
// workspace (a chat existing off the board).
{
  const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
  const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
  check('P4 the focused slot rests on no session by default', slot.hasFocusedSession() === false && slot.getFocusedSessionConnector() instanceof NoSessionConnector && slot.getFocusedSessionConnector().sessionId() === '')
  let beats = 0
  const off = slot.subscribeFocusedSessionConnector(() => beats++)
  const probe = new NoSessionConnector()
  slot.setFocusedSessionConnector(probe)
  check('P4 handing the slot a connector re-points it and notifies', slot.getFocusedSessionConnector() === probe && slot.hasFocusedSession() === true && beats === 1)
  const before = slot.claimHopEpoch()
  slot.releaseFocusedSessionConnector()
  check('P4 closing the chat rests the slot again, notifies, and claims the epoch (a late hop never re-points a closed chat)', slot.hasFocusedSession() === false && beats === 2 && !slot.hopEpochIsCurrent(before))
  slot.releaseFocusedSessionConnector()
  check('P4 closing a resting slot is a no-op (no spurious beat)', beats === 2)
  off()
  const src = read('src/services/engine-connector/focusedConnector.ts')
  check('P4 the slot has no engine behind it and no lazily minted boot chat', !src.includes('inProcessConnector') && !src.includes('bootChat') && !src.includes('NascentSessionConnector'))
  const ghosts = walk(join(process.cwd(), 'src')).filter(f => {
    const text = readFileSync(f, 'utf8')
    return /NascentSessionConnector|isNascentConnector|focusNascentSession|nascentConnector\.js/.test(text)
  })
  check('P4 no ghost spelling survives anywhere in the product tree (the kill-list completeness walk)', ghosts.length === 0, ghosts.map(f => f.replace(process.cwd() + '/', '')).join(', '))
}

// ── P5: the recap is display-only ───────────────────────────────────────────
{
  const hop = read('src/services/switchboard/hopIntoSession.ts')
  check('P5 the recap rides the same builder + gate as every resume', hop.includes('isAwaySummaryEnabled') && hop.includes('buildAwayRecap'))
  check('P5 the recap paints as a display row, never a recorded one', hop.includes('addDisplayRow'))
  const seatSrc = read('src/services/engine-connector/daemonConnector.ts')
  check('P5 display rows never reach a writer (paint only)', seatSrc.includes('private displayRows') && !seatSrc.includes('recordTranscript'))
}

// ── P6: the hop fence + the birth-time model ────────────────────────────────
// The kinetic switch-fence law: rapid hops A → B → C leave the LAST-CHOSEN
// session owning the commit — every hop claims an epoch before its load and
// commits only while that epoch is current. And the model a session is born
// on is read at BIRTH time from its owner (the screen's main model, or the
// caller's pick), never from a render sample of the screen.
{
  const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
  const older = slot.claimHopEpoch()
  const newer = slot.claimHopEpoch()
  check('P6 the fence: an older hop is refused once a newer one was chosen (the last-chosen session owns the commit)', !slot.hopEpochIsCurrent(older) && slot.hopEpochIsCurrent(newer))
  const seatSrc = read('src/services/engine-connector/daemonConnector.ts')
  const fenceAt = seatSrc.indexOf('const epoch = claimHopEpoch()')
  const attachAt = seatSrc.indexOf('await connector.attach()', fenceAt)
  const commitAt = seatSrc.indexOf('setFocusedSessionConnector(connector)', attachAt)
  check('P6 the hop claims its epoch BEFORE the load and commits only while current', fenceAt !== -1 && attachAt > fenceAt && commitAt > attachAt && seatSrc.slice(attachAt, commitAt).includes('if (!hopEpochIsCurrent(epoch)) return connector'))
  const repl = read('src/screens/REPL.tsx')
  const onSubmitAt = repl.indexOf('const onSubmit = useCallback(')
  const onSubmitEnd = repl.indexOf('const onSubmitRef = useRef(onSubmit)', onSubmitAt)
  const submitBody = repl.slice(onSubmitAt, onSubmitEnd)
  check('P6 the screen passes NO model into a session send (the runner owns the wire) — the poison is a render-sampled read', onSubmitAt !== -1 && !submitBody.includes('mainLoopModel') && !/sendWords\([^)]*model/.test(submitBody))
  const birthSrc = read('src/services/switchboard/bornSession.ts')
  // The owner grew a precedence (L18, birthModelOf): the menu's explicit
  // choice > the door's inheritance > the screen's main — still read at
  // birth inside the door, never a render sample.
  check('P6 the birth door reads the model at birth from its owner (never a render sample)', birthSrc.includes('const screen = screenBirthModel()') && birthSrc.includes('const model = screen === undefined ? undefined : birthModelOf(facts, req.model ?? null, screen)'))
  check("P6 the session's words carry no model of the screen's (the envelope names the target and the words)", !/op: 'sessionDispatch'[\s\S]{0,400}model:/.test(seatSrc))
}

// ── P7: the overlay input scope (the credential double-delivery class) ──────
// While an overlay owns the keyboard — a dialog command's surface (a hidden
// key entry among them), the palette, file-open, content search, the bashes
// dialog — not one byte reaches the composer, the queue, the transcript or
// the wire; the entry's ↵ settles the entry only. The poison is the old
// focus expression, which gated on the footer/search/helm/covered set and
// left the composer consuming beside every overlay.
{
  const prompt = read('src/components/PromptInput/PromptInput.tsx')
  check('P7 the composer\'s focus gate names the overlay union', /const keyboardOwnedByOverlay =[\s\S]{0,400}isLocalJSXCommandActive/.test(prompt))
  check('P7 the text input and the caret stand down while an overlay owns the keyboard', /const inputFocused =[\s\S]{0,220}!keyboardOwnedByOverlay/.test(prompt) && /const showCursor =[\s\S]{0,220}!keyboardOwnedByOverlay/.test(prompt))
  check('P7 the poison is gone: no focus expression stops at the covered fence', !/const inputFocused =\s*\n\s*footerSelection === null && !isSearchingHistory && helmOnPrompt && !surfaceCovered\s*\n/.test(prompt))
  check('P7 typing-wins suppression stays OUT of the byte gate (suppressed dialogs never deadlock the composer)', !/keyboardOwnedByOverlay =[\s\S]{0,400}hasSuppressedDialogs/.test(prompt))
}

// ── P8: the warm claim at the source seams (the line-7 restoration) ─────────
// The birth admits exactly as the first message used to; ADMISSION may land
// it on the workspace's pre-booted warm runner (the felt Enter is the old
// Enter). The laws at this altitude: the claim is consulted only for a
// FRESH exclusive session with no runner-side options; the record mints
// only AFTER the runner acknowledges the one claim control; a decline of
// any kind falls through to the cold spawn (the pool is an optimisation,
// never a dependency); and the screen arms the pool from the same mount
// hook that pre-warms the daemon. (The driven halves live in
// scripts/daemon/prove-warm-runner.ts and the live daemon-laws leg.)
{
  const sup = read('src/daemon/concourseSupervisor.ts')
  const claimAt = sup.indexOf('THE WARM CLAIM (claim-over-spawn)')
  const claimBody = claimAt !== -1 ? sup.slice(claimAt, sup.indexOf('// Lowest free worker slot', claimAt)) : ''
  check('P8 the claim seam exists inside admission', claimAt !== -1)
  check(
    'P8 the claim is consulted only for a fresh exclusive session with no runner argv',
    claimBody.includes('req.resumeSessionId === undefined') &&
      claimBody.includes("effectiveIsolation === 'exclusive'") &&
      claimBody.includes('req.runnerArgv === undefined || req.runnerArgv.length === 0'),
  )
  check(
    'P8 the record mints only AFTER the acknowledgement (claim await precedes the record write)',
    claimBody.indexOf('await deps.claimWarm(') !== -1 && claimBody.indexOf('await deps.claimWarm(') < claimBody.indexOf('updateConcourseWorkers('),
  )
  check('P8 a declined claim falls through to the cold path (never a refusal)', claimBody.includes('spawning cold'))
  check('P8 model validation precedes the claim (a refused model never reaches the pool)', sup.indexOf('await validateWorkerModelChoice(') < claimAt)
  const repl = read('src/screens/REPL.tsx')
  const mountAt = repl.indexOf('ensureOwnedDaemon()')
  check('P8 the screen arms the warm pool from the daemon pre-warm hook', mountAt !== -1 && repl.includes('warmSessionRunner(getCwd())'))
  const pool = read('src/daemon/warmRunner.ts')
  check('P8 the pool holds ONE runner per workspace and answers kept over a live one', pool.includes("return { state: 'kept'") && pool.includes('const pool = new Map<string, WarmRunnerEntry>()'))
}

console.log(failures === 0 ? '\nprove-seat-lifecycle: ALL LAWS HOLD' : `\nprove-seat-lifecycle: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
