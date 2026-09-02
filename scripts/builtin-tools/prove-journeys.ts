#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-journeys.ts — compositional local application
//  journeys, against a REAL node HTTP fixture service:
//    · successful journey: start → readiness → request → assertions →
//      log match → diagnostics → value assert → stop, all evidenced;
//    · incorrect status / body mismatch fail HONESTLY (later steps
//      skipped, verdict failed, no fake success);
//    · command failure · step timeout · failed readiness NAMES the unmet
//      condition · non-loopback refusal;
//    · cancellation settles 'cancelled' and cleanup reaps the service;
//    · cleanup stops journey-started services (verified dead);
//    · the journey is a census-classified execution with settled state;
//    · per-step canonical evidence on the ONE plane.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { runJourney, cancelJourney, _resetJourneysForTesting } = await import(
  '../../src/services/journeys/runner.ts'
)
const { getExecution } = await import('../../src/services/primitives/executionPlane.ts')
const { evidenceFor, _resetEvidencePlaneForTesting } = await import(
  '../../src/services/primitives/evidencePlane.ts'
)
const { resolveResource } = await import('../../src/services/resources/registry.ts')
await import('../../src/services/resources/adapters/journey.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const owner = processMainOwner()
const root = mkdtempSync(join(tmpdir(), 'builtin-tools-journeys-'))
const PORT = 42_617

// A real HTTP fixture: /health → 200 {ok:true}, /greet → 200 {msg:'hello'},
// /broken → 500. Logs one READY line + one request line per hit.
writeFileSync(
  join(root, 'server.mjs'),
  `import { createServer } from 'node:http'
const srv = createServer((req, res) => {
  console.log('hit ' + req.url)
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json','x-fixture':'arsenal'}); res.end(JSON.stringify({ok:true})); return }
  if (req.url === '/greet') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({msg:'hello', n: 7})); return }
  res.writeHead(500); res.end('boom')
})
srv.listen(${PORT}, '127.0.0.1', () => console.log('FIXTURE READY on ${PORT}'))
`,
)
writeFileSync(join(root, 'checkme.ts'), 'export const fine = 1\n')

function fixtureAlive(): boolean {
  try {
    execFileSync('bash', ['-c', `lsof -i :${PORT} -t | head -1`], { encoding: 'utf8', timeout: 5000 })
    const out = execFileSync('bash', ['-c', `lsof -i :${PORT} -t | wc -l`], { encoding: 'utf8', timeout: 5000 })
    return Number(out.trim()) > 0
  } catch {
    return false
  }
}

const START_STEP = {
  kind: 'service.start' as const,
  name: 'arsenal-fixture',
  command: process.execPath,
  args: ['server.mjs'],
  readiness: [{ kind: 'log' as const, regex: 'FIXTURE READY' }],
}

try {
  console.log('── the successful journey ──')
  const good = await runJourney(
    {
      objective: 'verify the fixture service end to end',
      steps: [
        START_STEP,
        { kind: 'service.wait', name: 'arsenal-fixture' },
        {
          kind: 'http.request',
          url: `http://127.0.0.1:${PORT}/health`,
          expect: { status: 200, bodyIncludes: '"ok":true', headerIncludes: { 'x-fixture': 'arsenal' } },
        },
        { kind: 'http.request', url: `http://127.0.0.1:${PORT}/greet`, expect: { status: 200 } },
        { kind: 'value.assert', jsonPath: 'msg', equals: 'hello' },
        { kind: 'log.match', service: 'arsenal-fixture', pattern: 'hit /greet' },
        { kind: 'diagnostic.check', files: ['checkme.ts'] },
        { kind: 'command.run', command: process.execPath, args: ['-e', "console.log('cli-ok')"], expect: { exitCode: 0, stdoutIncludes: 'cli-ok' } },
        { kind: 'service.stop', name: 'arsenal-fixture' },
      ],
    },
    { owner, root },
  )
  check('verdict succeeded', good.state === 'succeeded', JSON.stringify(good.steps.find(s => s.state !== 'passed'))?.slice(0, 200))
  check('all 9 steps passed', good.steps.every(s => s.state === 'passed'), `${good.steps.filter(s => s.state === 'passed').length}/9`)
  check('per-step evidence recorded', good.evidenceRefs.length >= 10, `${good.evidenceRefs.length}`)
  check('execution settled succeeded', getExecution(owner, good.id)?.state === 'succeeded')
  check('service reaped (explicit stop inside the journey)', !fixtureAlive())
  const res = await resolveResource(`mercury://journey/${good.id}`, { owner, cwd: root })
  check('mercury://journey/<id> resolves', res.state === 'ok')
  const planeEvidence = evidenceFor(owner)
  check(
    'journey checks live on the ONE evidence plane',
    planeEvidence.some(e => e.kind === 'check' && e.claim.includes(good.id)),
  )

  console.log('── incorrect status → honest failure ──')
  const badStatus = await runJourney(
    {
      objective: 'detect a wrong http status',
      steps: [
        START_STEP,
        { kind: 'service.wait', name: 'arsenal-fixture' },
        { kind: 'http.request', url: `http://127.0.0.1:${PORT}/broken`, expect: { status: 200 } },
        { kind: 'command.run', command: process.execPath, args: ['-e', '1'], label: 'never-runs' },
      ],
    },
    { owner, root },
  )
  check('verdict failed on status 500≠200', badStatus.state === 'failed' && badStatus.failedStep === 2)
  check('failure detail names the mismatch', badStatus.steps[2]!.detail.includes('500'), badStatus.steps[2]!.detail)
  check('later steps SKIPPED (no fake success)', badStatus.steps[3]!.state === 'skipped')
  check('cleanup stopped the started service', badStatus.cleanup.some(c => c.service === 'arsenal-fixture' && c.action === 'stopped') && !fixtureAlive())
  check('execution settled failed', getExecution(owner, badStatus.id)?.state === 'failed')

  console.log('── body mismatch + command failure + timeout ──')
  const badBody = await runJourney(
    {
      objective: 'detect a body mismatch',
      steps: [
        START_STEP,
        { kind: 'service.wait', name: 'arsenal-fixture' },
        { kind: 'http.request', url: `http://127.0.0.1:${PORT}/health`, expect: { bodyIncludes: 'NOPE' } },
      ],
    },
    { owner, root },
  )
  check('body mismatch fails with the observed body named', badBody.state === 'failed' && badBody.steps[2]!.detail.includes('NOPE'))

  const badCmd = await runJourney(
    {
      objective: 'detect a failing command',
      steps: [{ kind: 'command.run', command: process.execPath, args: ['-e', 'process.exit(3)'] }],
    },
    { owner, root },
  )
  check('command failure names exit 3 ≠ 0', badCmd.state === 'failed' && badCmd.steps[0]!.detail.includes('3'))

  const timedOut = await runJourney(
    {
      objective: 'detect a step timeout',
      steps: [
        { kind: 'command.run', command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 800 },
      ],
    },
    { owner, root },
  )
  check('step timeout fails honestly', timedOut.state === 'failed' && timedOut.steps[0]!.detail.includes('timed out'))

  console.log('── failed readiness names the unmet condition ──')
  const neverReady = await runJourney(
    {
      objective: 'detect unmet readiness',
      steps: [
        {
          kind: 'service.start',
          name: 'arsenal-never',
          command: process.execPath,
          args: ['-e', "console.log('starting'); setTimeout(()=>{}, 30000)"],
          readiness: [{ kind: 'log', regex: 'WILL NEVER APPEAR' }],
        },
        { kind: 'service.wait', name: 'arsenal-never', timeoutMs: 1_500 },
      ],
    },
    { owner, root },
  )
  check(
    'unmet readiness NAMED in the failure',
    neverReady.state === 'failed' && neverReady.steps[1]!.detail.includes('unmet'),
    neverReady.steps[1]?.detail,
  )
  check('never-ready service still cleaned up', neverReady.cleanup.some(c => c.service === 'arsenal-never' && c.action === 'stopped'))

  console.log('── loopback law ──')
  const nonLoopback = await runJourney(
    {
      objective: 'refuse a non-loopback url',
      steps: [{ kind: 'http.request', url: 'http://example.com/x' }],
    },
    { owner, root },
  )
  check('non-loopback refused (named)', nonLoopback.state === 'failed' && nonLoopback.steps[0]!.detail.includes('loopback'))

  console.log('── cancellation ──')
  const ac = new AbortController()
  const cancelPromise = runJourney(
    {
      objective: 'cancel mid-journey',
      steps: [
        START_STEP,
        { kind: 'service.wait', name: 'arsenal-fixture' },
        { kind: 'command.run', command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 30000)'], timeoutMs: 25_000 },
        { kind: 'http.request', url: `http://127.0.0.1:${PORT}/health` },
      ],
    },
    { owner, root, signal: ac.signal },
  )
  setTimeout(() => ac.abort(), 1_200)
  const cancelled = await cancelPromise
  check('cancellation settles cancelled (never failed-as-success)', cancelled.state === 'cancelled', cancelled.state)
  check('cancelled journey cleaned up its service', cancelled.cleanup.some(c => c.service === 'arsenal-fixture') && !fixtureAlive())
  check('execution settled cancelled', getExecution(owner, cancelled.id)?.state === 'cancelled')
  check('cancelJourney on a settled journey answers false', cancelJourney(owner, cancelled.id) === false)
} finally {
  try {
    execFileSync('bash', ['-c', `lsof -i :${PORT} -t | xargs kill -9 2>/dev/null || true`], { timeout: 5000 })
  } catch {
    /* best-effort */
  }
  rmSync(root, { recursive: true, force: true })
  _resetJourneysForTesting()
  _resetEvidencePlaneForTesting()
}

console.log(failures === 0 ? 'JOURNEYS: ALL GREEN' : `JOURNEYS: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
