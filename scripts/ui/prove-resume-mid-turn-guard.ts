import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

let failures = 0
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${label}`)
  if (!ok) failures++
}

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

const hop = read('src/services/switchboard/hopIntoSession.ts')
const fnAt = hop.indexOf('async function focusResumedSessionLanding(')
check('the hop owner declares the one resume path', fnAt !== -1)
const fnBody = hop.slice(fnAt, hop.indexOf('\n}\n', fnAt))
check('a session live on the board is ENTERED first (a hop, never a resume)', fnBody.indexOf('sessionOwnedByLiveWorker(') !== -1 && fnBody.indexOf('sessionOwnedByLiveWorker(') < fnBody.indexOf("op: 'sessionAdmit'"))
check('a durable session is admitted with --resume as a managed session', fnBody.includes('resumeSessionId: sessionId'))
check('the resume never yields, attaches or respawns a runner', !/action: '(attach|respawn|stop)'/.test(fnBody) && !fnBody.includes("op: 'concourseRespawn'"))

if (failures > 0) {
  console.error(`\n❌ resume-mid-turn-guard: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✅ resume-mid-turn-guard GREEN')
