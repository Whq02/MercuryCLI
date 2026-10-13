import { deepStrictEqual, equal, rejects, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { PermissionRule, PermissionUpdate } from '../../src/types/permissions.js'

const events: unknown[] = []
const context = { original: true }
const updated = { updated: true }
let managedOnly = false
let failAt = ''
let decision: unknown = { behavior: 'allow', updatedInput: {} }
const engineTrace = { steps: [1] }
const wrapper = { steps: [2] }
const effect = (name: string, ...args: unknown[]): void => {
  events.push([name, ...args])
  if (failAt === name) throw new Error(name)
}
const ports: Record<string, unknown> = {
  '../debug.js': { logForDebugging: (text: string) => effect('log', text) },
  './decision/wrapper.js': {
    decideToolPermissionWithModes: async (...args: unknown[]) => { effect('decision', ...args); return { decision, engineTrace, wrapper } },
  },
  './decision/engine.js': {
    decideRuleBasedPermissions: async (...args: unknown[]) => { effect('ruleDecision', ...args); return { decision } },
  },
  './decision/rules.js': {},
  './decision/requestMessage.js': {},
  './permissionsLoader.js': {
    shouldAllowManagedPermissionRulesOnly: () => { effect('managed'); return managedOnly },
    deletePermissionRuleFromSettings: (rule: unknown) => effect('disk', rule),
  },
  './PermissionUpdate.js': {
    applyPermissionUpdate: (...args: unknown[]) => { effect('one', ...args); return updated },
    applyPermissionUpdates: (...args: unknown[]) => { effect('batch', ...args); return updated },
  },
}
const api = {} as typeof import('../../src/utils/permissions/permissions.js')
const compiled = ts.transpileModule(readFileSync(resolve(import.meta.dir, '../../src/utils/permissions/permissions.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
new Function('require', 'exports', compiled)((name: string) => {
  if (!(name in ports)) throw new Error(`Unexpected dependency ${name}`)
  return ports[name]
}, api)

const rule = (source: PermissionRule['source'], ruleBehavior: PermissionRule['ruleBehavior'], name: string): PermissionRule =>
  ({ source, ruleBehavior, ruleValue: { toolName: name, reason: `reason for ${name}` } })
const rules = [rule('session', 'deny', 'Read'), rule('userSettings', 'allow', 'Bash'), rule('session', 'deny', 'Grep')]
rules.push(rules[0]!)
const expectedGroups = (type: string) => [
  { type, rules: [rules[0]!.ruleValue, rules[2]!.ruleValue, rules[3]!.ruleValue], behavior: 'deny', destination: 'session' },
  { type, rules: [rules[1]!.ruleValue], behavior: 'allow', destination: 'userSettings' },
]
for (const input of [[], rules]) {
  events.length = 0
  strictEqual(api.applyPermissionRulesToPermissionContext(context as never, input), updated)
  deepStrictEqual(events, [['batch', context, input.length ? expectedGroups('addRules') : []]])
}
for (const managed of [false, true]) {
  managedOnly = managed
  events.length = 0
  strictEqual(api.syncPermissionRulesFromDisk(context as never, rules), updated)
  const sources = managed
    ? ['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session', 'userSettings', 'projectSettings', 'localSettings']
    : ['userSettings', 'projectSettings', 'localSettings']
  const clears = sources.flatMap(destination => ['allow', 'deny', 'ask'].map(behavior => ({ type: 'replaceRules', rules: [], behavior, destination })))
  deepStrictEqual(events, [['managed'], ['batch', context, [...clears, ...expectedGroups('replaceRules')]]])
  const changes = (events[1] as unknown[])[2] as Extract<PermissionUpdate, { rules: unknown }>[]
  strictEqual(changes.at(-2)!.rules[0], rules[0]!.ruleValue)
  strictEqual(changes.at(-2)!.rules[2], rules[0]!.ruleValue)
}
for (const source of ['policySettings', 'flagSettings', 'command', 'userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'] as const) {
  events.length = 0
  const target = rule(source, 'ask', 'Read')
  const run = () => api.deletePermissionRule({ rule: target, initialContext: context as never, setToolPermissionContext: next => effect('publish', next) })
  if (['policySettings', 'flagSettings', 'command'].includes(source)) {
    await rejects(run, { message: 'Rules from read-only settings cannot be deleted.' })
    deepStrictEqual(events, [])
  } else {
    await run()
    deepStrictEqual(events, [
      ['one', context, { type: 'removeRules', rules: [target.ruleValue], behavior: 'ask', destination: source }],
      ...(['userSettings', 'projectSettings', 'localSettings'].includes(source) ? [['disk', target]] : []),
      ['publish', updated],
    ])
  }
}
for (const stage of ['one', 'disk', 'publish']) {
  failAt = stage
  events.length = 0
  await rejects(() => api.deletePermissionRule({ rule: rule('userSettings', 'allow', 'Read'), initialContext: context as never, setToolPermissionContext: next => effect('publish', next) }), { message: stage })
  deepStrictEqual(events.map(event => (event as string[])[0]), ['one', 'disk', 'publish'].slice(0, ['one', 'disk', 'publish'].indexOf(stage) + 1))
}
failAt = ''
const tool = { name: 'ProofTool' }
const input = { path: 'file' }
const assistant = { message: {} }
for (const outcome of [null, { behavior: 'ask', message: 'ask' }, { behavior: 'deny', message: 'deny' }, { behavior: 'allow', updatedInput: input }]) {
  decision = outcome
  events.length = 0
  strictEqual(await api.checkRuleBasedPermissions(tool as never, input, context as never), outcome)
  deepStrictEqual(events, [['ruleDecision', tool, input, context]])
  if (outcome === null) continue
  events.length = 0
  strictEqual(await api.hasPermissionsToUseTool(tool as never, input, context as never, assistant as never, 'call'), outcome)
  deepStrictEqual(events, [
    ['decision', tool, input, context, assistant, 'call'],
    ['log', `permission decision for ProofTool: ${outcome.behavior} — ${JSON.stringify({ engine: engineTrace, wrapper })}`],
  ])
}
for (const stage of ['decision', 'log']) {
  events.length = 0
  failAt = stage
  await rejects(() => api.hasPermissionsToUseTool(tool as never, input, context as never, assistant as never, 'call'), { message: stage })
  equal(events.length, stage === 'decision' ? 1 : 2)
}
console.log('PASS: rule batches, duplicate clears, deletion effects, decision identity, logs and failure propagation')
