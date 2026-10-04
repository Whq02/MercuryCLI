#!/usr/bin/env bun
// gate-watch: src/runner/wire/* src/cli/run.ts src/cli/headless/runnerMethods.ts src/daemon/runnerConnection.ts src/daemon/headlessRun.ts src/services/acp/childSession.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const { METHODS, methodsFrom } = await import('../../src/runner/wire/methods.ts')
const { RUNNER_NOTIFICATION_METHODS, RUNNER_REQUEST_METHODS } = await import('../../src/cli/headless/runnerMethods.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

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
  const print = src('src/cli/run.ts')
  const hostRequests = methodsFrom('host', 'request').map(spec => spec.name)
  const hostNotifications = methodsFrom('host', 'notification').map(spec => spec.name)
  const armless = [...hostRequests, ...hostNotifications].filter(name => name !== 'initialize' && name !== '$/cancel_request' && !print.includes(`'${name}':`))
  check("every host method but initialize and $/cancel_request has an arm in the runner's arms object", armless.length === 0, j(armless))
  check('initialize is registered on its own (it gates the others)', print.includes("peer.onRequest('initialize'"))
  check('the binder lists every host request but initialize', j([...RUNNER_REQUEST_METHODS].sort()) === j(hostRequests.filter(name => name !== 'initialize').sort()), j(RUNNER_REQUEST_METHODS))
  check('the binder lists every host notification but $/cancel_request (the peer owns the cancel)', j([...RUNNER_NOTIFICATION_METHODS].sort()) === j(hostNotifications.filter(name => name !== '$/cancel_request').sort()), j(RUNNER_NOTIFICATION_METHODS))
}

section('§3 the host side: every method the runner sends is received by a host in the tree, and the daemon receives every one its capabilities admit')
{
  const hosts = ['src/daemon/runnerConnection.ts', 'src/services/acp/childSession.ts'].map(rel => ({ rel, text: src(rel) }))
  const runnerSent = methodsFrom('runner', 'request').concat(methodsFrom('runner', 'notification')).map(spec => spec.name).filter(name => name !== '$/cancel_request')
  const handled = (text: string, name: string): boolean => text.includes(`onRequest('${name}'`) || text.includes(`onNotification('${name}'`)
  const unreceived = runnerSent.filter(name => !hosts.some(host => handled(host.text, name)))
  check('every runner method has a receiver in some host', unreceived.length === 0, j(unreceived))
  const daemon = hosts[0]!.text
  const daemonMethods = ['row', 'session/applied', 'permission/request']
  check('the daemon (holds_asks, no elicitation) receives the rows, the applied verbs and the asks', daemonMethods.every(name => handled(daemon, name)), j(daemonMethods.filter(name => !handled(daemon, name))))
  check('the daemon declares no elicitation (the spawn builder) and so receives none', src('src/daemon/headlessRun.ts').includes('elicitation: false') && !handled(daemon, 'elicitation/request'))
  const editor = hosts[1]!.text
  check('the editor host receives the rows, the asks, the questions and their completion', ['row', 'permission/request', 'elicitation/request', 'elicitation/complete'].every(name => handled(editor, name)))
}

console.log('')
if (failures > 0) {
  console.log(`❌ method table census: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ method table census: every method has its schema, its arm and its receiver')
