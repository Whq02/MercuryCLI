#!/usr/bin/env bun
// gate-watch: src/daemon/runner-wire/* src/daemon/runner/runHeadless.ts src/daemon/runner/runnerMethods.ts src/daemon/runner-link/runnerConnection.ts src/daemon/runner-link/headlessRun.ts src/integrations/acp/childSession.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


const { METHODS, methodsFrom } = await import('../../src/daemon/runner-wire/methods.ts')
const { RUNNER_NOTIFICATION_METHODS, RUNNER_REQUEST_METHODS } = await import('../../src/daemon/runner/runnerMethods.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

type Spec = { name: string; from: 'host' | 'runner' | 'both'; kind: 'request' | 'notification'; params: () => unknown; result: () => unknown; scope: string; deadlineMs: number | null }
const specs = Object.values(METHODS) as Spec[]
console.log(`the runner door's method table — ${specs.length} methods`)

section('§1 every method declares its direction, its kind, a params schema and a result schema')
{
  const missing = specs.filter(spec => typeof spec.params !== 'function' || typeof spec.result !== 'function' || !['host', 'runner', 'both'].includes(spec.from) || !['request', 'notification'].includes(spec.kind))
  check('every entry is whole', missing.length === 0, j(missing.map(spec => spec.name)))
  const parse = specs.filter(spec => {
    try {
      spec.params()
      spec.result()
      return false
    } catch {
      return true
    }
  })
  check('every schema builds', parse.length === 0, j(parse.map(spec => spec.name)))
  const keys = Object.keys(METHODS)
  check('the table is keyed by the method names it declares', keys.every(key => (METHODS as Record<string, Spec>)[key]!.name === key), j(keys.filter(key => (METHODS as Record<string, Spec>)[key]!.name !== key)))
  const notifications = specs.filter(spec => spec.kind === 'notification')
  check('a notification carries no deadline', notifications.every(spec => spec.deadlineMs === null), j(notifications.filter(spec => spec.deadlineMs !== null).map(spec => spec.name)))
}

section('§2 the runner side: every method a host sends has an arm, and the binder binds them all')
{
  const { runnerArmsOf } = await import('../../src/daemon/runner/runnerArms.ts')
  const arms = Object.keys(runnerArmsOf(new Proxy({}, { get: () => undefined }) as never))
  const hostRequests = methodsFrom('host', 'request').map(spec => spec.name)
  const hostNotifications = methodsFrom('host', 'notification').map(spec => spec.name)
  const armless = [...hostRequests, ...hostNotifications].filter(name => name !== 'initialize' && name !== '$/cancel_request' && !arms.includes(name))
  check("every host method but initialize and $/cancel_request has an arm in the runner's arms object", armless.length === 0 && arms.length === hostRequests.length + hostNotifications.length - 2, j({ armless, arms: arms.length }))
  const { refusalOf, withLiveRunner } = await import('../lib/builtProduct.ts')
  const { RPC_NOT_INITIALIZED } = await import('../../src/daemon/runner-wire/errors.ts')
  const gate = await withLiveRunner(
    async runner => ({
      early: await Promise.all(RUNNER_REQUEST_METHODS.map(name => refusalOf(runner.request(name as never, {} as never)))),
      protocol: await runner.initialize().then(answer => answer.protocol, () => null),
      late: await refusalOf(runner.request('session/facts', {})),
    }),
    { initialize: false },
  )
  check('initialize is registered on its own (it gates the others)', gate.early.every(refusal => refusal?.code === RPC_NOT_INITIALIZED) && gate.protocol === 1 && gate.late === null, j(gate.early.map(refusal => refusal?.code)))
  check('the binder lists every host request but initialize', j([...RUNNER_REQUEST_METHODS].sort()) === j(hostRequests.filter(name => name !== 'initialize').sort()), j(RUNNER_REQUEST_METHODS))
  check('the binder lists every host notification but $/cancel_request (the peer owns the cancel)', j([...RUNNER_NOTIFICATION_METHODS].sort()) === j(hostNotifications.filter(name => name !== '$/cancel_request').sort()), j(RUNNER_NOTIFICATION_METHODS))
}


console.log('')
if (failures > 0) {
  console.log(`❌ method table census: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ method table census: every method has its schema, its arm and its receiver')
