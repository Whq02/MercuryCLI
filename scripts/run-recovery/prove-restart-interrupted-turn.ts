#!/usr/bin/env bun
// ============================================================================
//  scripts/run-recovery/prove-restart-interrupted-turn.ts — §11 scenario 17.
//
//  ORACLE: process restart after an INTERRUPTED turn reconstructs honestly —
//  the real dist is SIGKILLed mid-provider-stream (the fixture hangs after
//  one delta), then relaunched with --resume. The second process must see:
//  the turn-1 user message exactly once, NO fabricated completion (the
//  unsettled partial delta never becomes a settled assistant fact), and a
//  working turn 2. The abrupt-death shape is the reliability suite's; what
//  no domain suite drives is the RESTART SEMANTICS across owners: session
//  storage reload × run core resume × the boot recovery pass × the provider
//  request actually sent after reconstruction.
//
//  Kill discipline: the child runs detached in its own process group and the
//  WHOLE group is SIGKILLed — no orphaned sidecars can outlive the scene.
//  Barriers: the fixture's own request/emit records (observed readiness),
//  hard deadlines retained, no arbitrary sleeps.
//
//  Run:  ~/.bun/bin/bun run scripts/run-recovery/prove-restart-interrupted-turn.ts
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

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
const fixture = await startFixtureApi(fixtureTurns)

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
  MERCURY_TEAMS_DIR: join(home, 'teams'),
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

// ── turn 1: stream starts, then the PROCESS GROUP dies mid-stream ──────────
const kill1 = await new Promise<{ exit: number | null; signal: string | null; stdout: string }>(resolvePromise => {
  const child = spawn(nodeBin!, [DIST, '-p', 'interrupted prompt', '--model', 'claude-opus-4-8', '--session-id', SID], {
    cwd,
    env,
    detached: true, // own process group — the group kill reaps any sidecars
  })
  let stdout = ''
  child.stdout.on('data', d => (stdout += d))
  child.stderr.on('data', () => {})
  const hardDeadline = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
  }, 60_000)
  // Observed readiness: kill only when the turn is durably UNDERWAY — the
  // provider stream started (fixture recorded the request) AND the user
  // message reached the transcript. Killing before the first durable write
  // is a different scene (the prompt-flush crash window, reliability's
  // domain); THIS scenario is reconstruction of an in-flight turn.
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
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
    }
  }, 25)
  child.on('close', (exit, signal) => {
    clearTimeout(hardDeadline)
    clearInterval(poll)
    resolvePromise({ exit, signal: signal as string | null, stdout })
  })
})
check('turn 1 died by SIGKILL (mid-stream)', kill1.signal === 'SIGKILL' || kill1.exit !== 0, `exit=${kill1.exit} signal=${kill1.signal}`)
check('turn 1 printed no completion', !kill1.stdout.includes(PARTIAL), JSON.stringify(kill1.stdout.slice(0, 120)))

// ── the durable truth after the kill ───────────────────────────────────────
{
  const files = transcriptFiles()
  const hasPrompt = files.some(f =>
    f.text.split('\n').some(l => (l.includes('"type":"user"') || l.includes('"kind":"input"')) && l.includes('interrupted prompt')),
  )
  const fabricated = files.some(f =>
    f.text.split('\n').some(l => l.includes('"type":"assistant"') && l.includes(PARTIAL)),
  )
  check('the turn-1 user message survived the kill (durable before dispatch)', hasPrompt)
  check('the unsettled partial was NOT persisted as a settled assistant', !fabricated)
}

// ── restart: --resume must reconstruct honestly and run turn 2 ─────────────
const r2 = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(resolvePromise => {
  const child = spawn(nodeBin!, [DIST, '-p', 'second prompt', '--model', 'claude-opus-4-8', '--resume', SID], { cwd, env })
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
check('resume exit 0 (an interrupted predecessor is recoverable, not fatal)', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(0, 300)}`)
check('turn 2 completed', r2.stdout.includes('S17-SECOND-REPLY'), JSON.stringify(r2.stdout.slice(0, 160)))

// The reconstruction laws at the PROVIDER consumer (what the wire actually
// saw after restart is the ground truth of what was reconstructed):
const msgs = fixture.messageRequests()
check('exactly two model calls (killed turn + resumed turn — no replay storm)', msgs.length === 2, String(msgs.length))
const resumeBody = JSON.stringify(msgs[1]?.body ?? {})
const promptCount = (resumeBody.match(/interrupted prompt/g) ?? []).length
check('the resume request carries the turn-1 prompt exactly once', promptCount === 1, `count=${promptCount}`)
check('the resume request carries NO fabricated turn-1 completion', !resumeBody.includes(PARTIAL))

// And the durable consumer after resume: still exactly one user entry, still
// no fabricated assistant, per file.
for (const f of transcriptFiles()) {
  const userN = f.text.split('\n').filter(l => (l.includes('"type":"user"') || l.includes('"kind":"input"')) && l.includes('interrupted prompt')).length
  const fabN = f.text.split('\n').filter(l => l.includes('"type":"assistant"') && l.includes(PARTIAL)).length
  check(`one user entry, zero fabricated completions (${f.path.split('/').pop()})`, userN <= 1 && fabN === 0, `user=${userN} fab=${fabN}`)
}

await fixture.close()

console.log('')
if (failures > 0) {
  console.log(`❌ S17: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ S17: an interrupted turn reconstructs honestly — nothing fabricated, nothing duplicated')
