// ============================================================================
//  prove-resume-mid-turn-guard — the SESSION-SWITCH-MID-TURN class stays dead.
//
//  The class (operator repro, Dubz): an in-place session switch while a
//  query was in flight re-pointed the session file pointer MID-TURN — the
//  running turn's assistant tail + stop hooks appended to the TARGET
//  session's JSONL while the prompt that started the turn stayed behind in
//  the source session. Operator-visible symptom: "my message vanished".
//
//  The class is dead BY CONSTRUCTION: every session is a managed session
//  with its own runner and its own file, and the screen's resume() never
//  touches a session file — it re-points the FOCUSED SLOT at the target's
//  connector through the one resume path (focusResumedSession). A running
//  turn keeps running in its own process; nothing is switched under it.
//
//  This proof pins that shape structurally (REPL.tsx is a component
//  closure — not unit-loadable), the way scripts/audit-fixes/ pins
//  confirmed defects:
//    1. resume() performs no session mutation of its own (no switchSession,
//       no executeSessionEndHooks, no file-pointer move, no draft flush) —
//       the whole body is the slot re-point plus its receipts;
//    2. the switch surfaces still route through context.resume (the
//       chokepoint assumption stays true — if /sessiontab ever grows its own
//       switch machinery this proof must fail);
//    3. the mid-turn path is the SAME path: a session live on the board is
//       entered (a hop), never resumed or respawned — the hop owner checks
//       the live record before any admission.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

let failures = 0
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${label}`)
  if (!ok) failures++
}

//
// 1. REPL.tsx: resume() is the slot re-point and nothing else.
//
const repl = read('src/screens/REPL.tsx')

const resumeStart = repl.indexOf('const resume = useCallback(')
check('REPL declares the resume useCallback', resumeStart !== -1)
const resumeEnd = repl.indexOf('resumeRef.current = resume', resumeStart)
const resumeBody = repl.slice(resumeStart, resumeEnd)
check('resume() re-points the focused slot through the one resume path', resumeBody.includes('focusResumedSession('))
check('resume() never switches the session file pointer', !resumeBody.includes('switchSession(') && !resumeBody.includes('resetSessionFilePointer(') && !resumeBody.includes('adoptResumedSessionFile('))
check('resume() fires no session-end hooks of its own (the runner owns its hooks)', !resumeBody.includes('executeSessionEndHooks('))
check('resume() never flushes or rewrites the composer draft', !resumeBody.includes('flushDrafts(') && !resumeBody.includes('readDraftFor('))
check('resume() never gates on the query guard (a running turn is never a refusal)', !resumeBody.includes('queryGuard'))

//
// 2. The chokepoint assumption: switch surfaces still flow through
//    context.resume (no parallel switch machinery has grown).
//
const sessiontab = read('src/commands/sessiontab/sessiontab.tsx')
check(
  '/sessiontab routes through context.resume (chokepoint intact)',
  sessiontab.includes('context.resume!(') &&
    !sessiontab.includes('switchSession('),
)

const sessionsView = read(
  'src/components/mercury-ui/screens/SessionManagerView.tsx',
)
check(
  'SessionManagerView switches via its threaded onResume (no direct switchSession)',
  sessionsView.includes('onResume') && !sessionsView.includes('switchSession('),
)

//
// 3. The hop owner: a session live on the board is entered before any
//    admission; a durable one is admitted as a managed session (--resume)
//    behind its first paint. No attach, no yield, no respawn.
//
const hop = read('src/services/switchboard/hopIntoSession.ts')
// Re-cut to the landing-gate wrap: focusResumedSession is a sync wrapper;
// the one resume path lives in focusResumedSessionLanding.
const fnAt = hop.indexOf('async function focusResumedSessionLanding(')
check('the hop owner declares the one resume path', fnAt !== -1)
const fnBody = hop.slice(fnAt, hop.indexOf('\n}\n', fnAt))
check('a session live on the board is ENTERED first (a hop, never a resume)', fnBody.indexOf('sessionOwnedByLiveWorker(') !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') < fnBody.indexOf("op: 'sessionAdmit'"))
check('a durable session is admitted with --resume as a managed session', fnBody.includes('resumeSessionId: sessionId'))
// Scoped to the resume path: /clear's own door (clearFocusedSession) stops
// and releases a session by design and lives in the same file.
check('the resume never yields, attaches or respawns a runner', !/action: '(attach|respawn|stop)'/.test(fnBody) && !fnBody.includes("op: 'concourseRespawn'"))

//
if (failures > 0) {
  console.error(`\n❌ resume-mid-turn-guard: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ resume-mid-turn-guard GREEN')
