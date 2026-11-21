#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — scenario exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

console.log('============================================================')
console.log(' S17 — restart after an INTERRUPTED turn (honest reconstruction)')
console.log('============================================================')

const SID = 'facef00d-0000-4000-8000-00000000c170'
const PARTIAL = 'S17-PARTIAL-NEVER-SETTLED'
const fixtureTurns: ScriptedTurn[] = [
  { kind: 'hang', deltas: [PARTIAL] },
  { kind: 'text', text: 'S17-SECOND-REPLY' },
]
const fixture = await startFixtureApi([handoffTurn(), ...fixtureTurns])

const home = mkdtempSync(join(tmpdir(), 'convergence-s17-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'convergence-s17-cwd-'))
mkdirSync(join(home, '.mercury'), { recursive: true })
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: join(home, '.mercury'),
  ANTHROPIC_BASE_URL: fixture.url,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_VERIFY_EVIDENCE: '0',
}

const projectDirRoot = join(home, '.mercury', 'projects')
function transcriptFiles(): Array<{ path: string; text: string }> {
  if (!existsSync(projectDirRoot)) return []
  const out: Array<{ path: string; text: string }> = []
  const stack = [projectDirRoot]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.endsWith('.jsonl')) out.push({ path: p, text: readFileSync(p, 'utf-8') })
    }
  }
  return out
}

const kill1 = await new Promise<{ exit: number | null; signal: string | null; stdout: string }>(resolvePromise => {
  const child = spawn(nodeBin!, [DIST, 'run', 'interrupted prompt', '--model', 'claude-opus-4-8', '--session-id', SID], {
    cwd,
    env,
    detached: true,
  })
  let stdout = ''
  child.stdout.on('data', d => (stdout += d))
  child.stderr.on('data', () => {})
  const hardDeadline = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL') } catch {  }
  }, 60_000)
  const durablyUnderway = (): boolean => {
    if (fixture.messageRequests().length < 1) return false
    for (const f of transcriptFiles()) {
      if (f.text.split('\n').some(l => (l.includes('"type":"user"') || l.includes('"kind":"input"')) && l.includes('interrupted prompt'))) return true
    }
    return false
  }
  const poll = setInterval(() => {
    if (durablyUnderway()) {
      clearInterval(poll)
      try { process.kill(-child.pid!, 'SIGKILL') } catch {  }
    }
  }, 25)
  child.on('close', (exit, signal) => {
    clearTimeout(hardDeadline)
    clearInterval(poll)
    resolvePromise({ exit, signal: signal as string | null, stdout })
  })
})
check('turn 1 died by SIGKILL (mid-stream)', kill1.signal === 'SIGKILL' || kill1.exit !== 0, `exit=${kill1.exit} signal=${kill1.signal}; the run should be killed while the fixture holds the stream open, so check that the fixture hang turn was served and that the 60s hard deadline in this file did not end it`)
check('turn 1 printed no completion', !kill1.stdout.includes(PARTIAL), JSON.stringify(kill1.stdout.slice(0, 120)) + '; an unsettled partial must never be printed as a completed answer, so look at what the headless run verb prints for a stream that never finished')

{
  const files = transcriptFiles()
  const hasPrompt = files.some(f =>
    f.text.split('\n').some(l => (l.includes('"type":"user"') || l.includes('"kind":"input"')) && l.includes('interrupted prompt')),
  )
  const fabricated = files.some(f =>
    f.text.split('\n').some(l => l.includes('"type":"assistant"') && l.includes(PARTIAL)),
  )
  check('the turn-1 user message survived the kill (durable before dispatch)', hasPrompt, 'no transcript .jsonl under the config home projects folder holds the prompt as a user or input entry; the prompt must be written to the session transcript before the model request is sent')
  check('the unsettled partial was NOT persisted as a settled assistant', !fabricated, 'a transcript has an assistant entry carrying the streamed partial; a stream that never settled must not be written as an assistant message')
}

const r2 = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(resolvePromise => {
  const child = spawn(nodeBin!, [DIST, 'run', 'second prompt', '--model', 'claude-opus-4-8', '--resume', SID], { cwd, env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => (stdout += d))
  child.stderr.on('data', d => (stderr += d))
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  child.on('close', exit => {
    clearTimeout(killer)
    resolvePromise({ exit, stdout, stderr })
  })
})
check('resume exit 0 (an interrupted predecessor is recoverable, not fatal)', r2.exit === 0, `stderr=${r2.stderr.slice(0, 300)} exit=${r2.exit}; resuming a session whose last turn never settled must load it and run, so read stderr for the refusal`)
check('turn 2 completed', r2.stdout.includes('S17-SECOND-REPLY'), JSON.stringify(r2.stdout.slice(0, 160)) + '; the resumed run did not print the second scripted reply, so check that the second fixture turn was reached and the resumed request was sent')

const allRequests = fixture.messageRequests()
check('no marked closing ask rides either process: not before the kill, not after the resumed answer (an unattended run leaves no note)', JSON.stringify(allRequests.map(isHandoffRequest)) === JSON.stringify([false, false]), JSON.stringify(allRequests.map(isHandoffRequest)) + '; a headless run must not send the marked closing ask, so find what sent it')
const msgs = allRequests.filter(q => !isHandoffRequest(q))
check('exactly two model calls (killed turn + resumed turn — no replay storm)', msgs.length === 2, String(msgs.length) + ' model calls; expected the killed turn and the resumed turn only, so look for a resume that replays or skips the interrupted turn')
const resumeBody = JSON.stringify(msgs[1]?.body ?? {})
const promptCount = (resumeBody.match(/interrupted prompt/g) ?? []).length
check('the resume request carries the turn-1 prompt exactly once', promptCount === 1, `count=${promptCount}; the interrupted prompt must appear once in the history sent on resume, so look at how the resumed session rebuilds its messages from the transcript`)
check('the resume request carries NO fabricated turn-1 completion', !resumeBody.includes(PARTIAL), 'the resume request contains the unsettled partial text; resume must rebuild history without a completion that never settled')

for (const f of transcriptFiles()) {
  const userN = f.text.split('\n').filter(l => (l.includes('"type":"user"') || l.includes('"kind":"input"')) && l.includes('interrupted prompt')).length
  const fabN = f.text.split('\n').filter(l => l.includes('"type":"assistant"') && l.includes(PARTIAL)).length
  check(`one user entry, zero fabricated completions (${f.path.split('/').pop()})`, userN <= 1 && fabN === 0, `user=${userN} fab=${fabN}; the prompt must be written once and no assistant entry may carry the partial, so look at what wrote this transcript on kill and on resume`)
}

await fixture.close()

console.log('')
if (failures > 0) {
  console.log(`❌ S17: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ S17: an interrupted turn reconstructs honestly — nothing fabricated, nothing duplicated')
