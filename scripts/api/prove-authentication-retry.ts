import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ASK, MODEL, REPO, argAfter, authWorld, nodeFor, proofRoot, runChild, type Arm } from './authRetryFixture.ts'

const dist = resolve(argAfter('--dist') ?? join(REPO, 'dist/mercury.mjs'))
const root = proofRoot()
const only = argAfter('--arm')
const arms: Arm[] = ['unavailable', 'failed', 'unchanged', 'refreshed', 'rejected', 'revoked', 'hint', 'api-key', 'env-bearer', 'helper-unchanged', 'helper-refreshed', 'burst']
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail: unknown, fix = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `: ${fix ? `${fix} | ` : ''}${JSON.stringify(detail).slice(0, 900)}`}`)
}

for (const arm of arms.filter(arm => !only || arm === only)) {
  const world = await authWorld(arm, process.argv.includes('--natural-backoff') ? '' : '0.001')
  try {
    const started = Date.now()
    const result = await runChild([nodeFor(dist), dist, 'run', '--format', 'rows', '--model', MODEL, ASK], world.cwd, world.env, 270_000)
    const frames = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    const terminal = frames.filter(row => row.type === 'outcome')
    const errors = terminal.filter(row => row.status !== 'completed' && row.error?.class === 'auth').map(row => row.error)
    const projects = join(world.home, 'projects')
    const records = readdirSync(projects, { recursive: true }).filter(path => String(path).endsWith('.jsonl')).flatMap(path => readFileSync(join(projects, String(path)), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
    const retries = records.filter(row => row.payload?.noticeKind === 'api_error').map(row => row.payload.fields)
    const requests = world.wires.filter(row => row.kind === 'request')
    const refreshes = world.wires.filter(row => row.kind === 'refresh')
    const success = arm === 'refreshed' || arm === 'helper-refreshed' || arm === 'burst'
    const twoRequests = success || arm === 'rejected'
    const helper = arm.startsWith('helper-')
    const expectedRefresh = arm === 'unavailable' || arm === 'api-key' || arm === 'env-bearer' || helper ? 0 : arm === 'burst' ? 0 : 1
    const record = { arm, dist, home: world.home, durationMs: Date.now() - started, code: result.code, timedOut: result.timedOut, wires: world.wires, helperCalls: world.helperCalls(), retries, terminal, errors }
    writeFileSync(join(root, `${arm}-record.json`), JSON.stringify(record, null, 2) + '\n')
    writeFileSync(join(root, `${arm}-stdout.jsonl`), result.stdout)
    writeFileSync(join(root, `${arm}-stderr.txt`), result.stderr)
    console.log(`[record] ${arm}: requests=${requests.length} refreshes=${refreshes.length} helpers=${world.helperCalls()} notices=${retries.length} duration=${record.durationMs}ms`)
    check(`${arm}: the built product settled`, !result.timedOut && terminal.length === 1, record, 'the child run must end with exactly one outcome row before the timeout; check the run loop and the 401 handling in src/engine/requests/withRetry.ts, and read ' + arm + '-stderr.txt in the proof root')
    check(`${arm}: only the justified requests reached the fixture`, requests.length === (twoRequests ? 2 : 1), requests, 'a 401 must lead to at most one retry request and only when the credential changed; change the 401 branch of the retry loop in src/engine/requests/withRetry.ts')
    check(`${arm}: credential recovery is attempted at most once`, refreshes.length === expectedRefresh && (!helper || world.helperCalls() === 2), record, 'credential recovery (refresh or helper rerun) must run at most once per 401; change authenticationRecoveryAttempted handling in src/engine/requests/withRetry.ts')
    if (success) {
      check(`${arm}: the outcome carries the accepted response`, terminal[0]?.status === 'completed' && String(terminal[0]?.answer ?? '').includes('fixture accepted'), terminal, 'after a recovered credential the retry must complete with the fixture answer; check the recovery branch in src/engine/requests/withRetry.ts')
      if (arm !== 'burst') check(`${arm}: the one retry carries the changed credential`, requests[1]?.bearer === 'fixture-fresh', requests, 'the retry after recovery must send the refreshed bearer; check that withRetry in src/engine/requests/withRetry.ts rebuilds the client after the refresh')
    } else {
      check(`${arm}: one terminal authentication blocker`, terminal[0]?.status === 'failed' && errors.length === 1, { terminal, errors }, 'a refused credential must end in one failed outcome whose error class is auth; check the 401 handling in src/engine/requests/withRetry.ts and the message built in src/engine/requests/apiErrorRows.ts')
      const blockerText = JSON.stringify(errors)
      check(`${arm}: the blocker names its remedy`, helper ? blockerText.includes('credentials.keyCommand') : arm === 'api-key' ? blockerText.includes('ANTHROPIC_API_KEY') : arm === 'env-bearer' ? blockerText.includes('ANTHROPIC_AUTH_TOKEN') && !blockerText.includes('ANTHROPIC_API_KEY') : blockerText.includes('/logins anthropic') && !blockerText.includes('@'), errors, 'the blocker text must name the remedy for this credential source and no account address; change the authentication failure message in src/engine/requests/apiErrorRows.ts')
    }
    check(`${arm}: authentication never schedules a wait`, arm === 'burst' || retries.length === 0, retries, 'an authentication failure must not record an api_error wait notice; change the 401 branch in src/engine/requests/withRetry.ts')
  } finally {
    world.close()
  }
}
console.log(`prove-authentication-retry: ${checks} checks, ${failures} failed; records ${root}`)
process.exit(failures ? 1 : 0)
