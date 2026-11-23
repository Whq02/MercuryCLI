import { deepStrictEqual, equal, rejects, strictEqual } from 'node:assert/strict'
import { mock } from 'bun:test'
import type { PermissionRule, PermissionUpdate } from '../../src/permissions/rules/permissions.js'

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
mock.module('../../src/platform/logs/debugLog.js', () => ({
  logForDebugging: (text: string) => effect('log', text),
}))
mock.module('../../src/permissions/rules/decision/wrapper.js', () => ({
  decideToolPermissionWithModes: async (...args: unknown[]) => {
    effect('decision', ...args)
    return { decision, engineTrace, wrapper }
  },
}))
mock.module('../../src/permissions/rules/decision/engine.js', () => ({
  decideRuleBasedPermissions: async (...args: unknown[]) => {
    effect('ruleDecision', ...args)
    return { decision }
  },
}))
mock.module('../../src/permissions/rules/permissionsLoader.js', () => ({
  shouldAllowManagedPermissionRulesOnly: () => {
    effect('managed')
    return managedOnly
  },
  deletePermissionRuleFromSettings: (rule: unknown) => effect('disk', rule),
  addPermissionRulesToSettings: () => {},
}))
mock.module('../../src/permissions/rules/permissionUpdate.js', () => ({
  applyPermissionUpdate: (...args: unknown[]) => {
    effect('one', ...args)
    return updated
  },
  applyPermissionUpdates: (...args: unknown[]) => {
    effect('batch', ...args)
    return updated
  },
}))
mock.module('../../src/permissions/rules/lateAllowRules.js', () => ({
  noteAllowRulesOfSettingsChange: (...args: unknown[]) => effect('arrived', ...args),
}))
mock.module('../../src/integrations/event-hooks/toolPermission.js', () => ({
  tellHooksHowAToolIsPermitted: () => {},
}))
const api = await import('../../src/permissions/rules/permissionDoor.js')

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
  strictEqual(api.applyPermissionRulesToPermissionContext(context as never, input), updated, 'applyPermissionRulesToPermissionContext in src/permissions/rules/permissionDoor.ts must return what applyPermissionUpdates returns')
  deepStrictEqual(events, [['batch', context, input.length ? expectedGroups('addRules') : []]], 'applyPermissionRulesToPermissionContext in src/permissions/rules/permissionDoor.ts must make one applyPermissionUpdates call with one addRules group per source and behavior (none for no rules)')
}
for (const managed of [false, true]) {
  managedOnly = managed
  events.length = 0
  strictEqual(api.syncPermissionRulesFromDisk(context as never, rules), updated, 'syncPermissionRulesFromDisk in src/permissions/rules/permissionDoor.ts must return what applyPermissionUpdates returns')
  const sources = managed
    ? ['userSettings', 'projectSettings', 'localSettings', 'cliArg', 'session', 'userSettings', 'projectSettings', 'localSettings']
    : ['userSettings', 'projectSettings', 'localSettings']
  const clears = sources.flatMap(destination => ['allow', 'deny', 'ask'].map(behavior => ({ type: 'replaceRules', rules: [], behavior, destination })))
  deepStrictEqual(events, [['managed'], ['batch', context, [...clears, ...expectedGroups('replaceRules')]], ['arrived', context, updated]], 'syncPermissionRulesFromDisk in src/permissions/rules/permissionDoor.ts must check managed-only first, clear every source and behavior, replace the grouped rules in one batch, then call noteAllowRulesOfSettingsChange')
  const changes = (events[1] as unknown[])[2] as Extract<PermissionUpdate, { rules: unknown }>[]
  strictEqual(changes.at(-2)!.rules[0], rules[0]!.ruleValue, 'syncPermissionRulesFromDisk in src/permissions/rules/permissionDoor.ts must keep a duplicate rule as the same rule value in its group')
  strictEqual(changes.at(-2)!.rules[2], rules[0]!.ruleValue, 'syncPermissionRulesFromDisk in src/permissions/rules/permissionDoor.ts must keep a duplicate rule as the same rule value in its group')
}
for (const source of ['policySettings', 'flagSettings', 'command', 'userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'] as const) {
  events.length = 0
  const target = rule(source, 'ask', 'Read')
  const run = () => api.deletePermissionRule({ rule: target, initialContext: context as never, setToolPermissionContext: next => effect('publish', next) })
  if (['policySettings', 'flagSettings', 'command'].includes(source)) {
    await rejects(run, { message: 'Rules from read-only settings cannot be deleted.' }, 'deletePermissionRule in src/permissions/rules/permissionDoor.ts must refuse a rule from policySettings, flagSettings or command with that message')
    deepStrictEqual(events, [], 'deletePermissionRule in src/permissions/rules/permissionDoor.ts must refuse a read-only source before any update, disk write or publish')
  } else {
    await run()
    deepStrictEqual(events, [
      ['one', context, { type: 'removeRules', rules: [target.ruleValue], behavior: 'ask', destination: source }],
      ...(['userSettings', 'projectSettings', 'localSettings'].includes(source) ? [['disk', target]] : []),
      ['publish', updated],
    ], 'deletePermissionRule in src/permissions/rules/permissionDoor.ts must apply removeRules, delete from disk only for user, project and local settings, then publish, in that order')
  }
}
for (const stage of ['one', 'disk', 'publish']) {
  failAt = stage
  events.length = 0
  await rejects(() => api.deletePermissionRule({ rule: rule('userSettings', 'allow', 'Read'), initialContext: context as never, setToolPermissionContext: next => effect('publish', next) }), { message: stage }, 'deletePermissionRule in src/permissions/rules/permissionDoor.ts must let a failure of its update, disk or publish step reach the caller')
  deepStrictEqual(events.map(event => (event as string[])[0]), ['one', 'disk', 'publish'].slice(0, ['one', 'disk', 'publish'].indexOf(stage) + 1), 'deletePermissionRule in src/permissions/rules/permissionDoor.ts must stop at the step that failed and run no later step')
}
failAt = ''
const tool = { name: 'ProofTool' }
const input = { path: 'file' }
const assistant = { message: {} }
for (const outcome of [null, { behavior: 'ask', message: 'ask' }, { behavior: 'deny', message: 'deny' }, { behavior: 'allow', updatedInput: input }]) {
  decision = outcome
  events.length = 0
  strictEqual(await api.checkRuleBasedPermissions(tool as never, input, context as never), outcome, 'checkRuleBasedPermissions in src/permissions/rules/permissionDoor.ts must return the decision of decideRuleBasedPermissions unchanged')
  deepStrictEqual(events, [['ruleDecision', tool, input, context]], 'checkRuleBasedPermissions in src/permissions/rules/permissionDoor.ts must call decideRuleBasedPermissions once with the tool, input and context')
  if (outcome === null) continue
  events.length = 0
  strictEqual(await api.hasPermissionsToUseTool(tool as never, input, context as never, assistant as never, 'call'), outcome, 'hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must return the decision of decideToolPermissionWithModes unchanged')
  deepStrictEqual(events, [
    ['decision', tool, input, context, assistant, 'call'],
    ['log', `permission decision for ProofTool: ${outcome.behavior} — ${JSON.stringify({ engine: engineTrace, wrapper })}`],
  ], 'hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must call decideToolPermissionWithModes once, then write one debug log line of the form permission decision for <tool>: <behavior> with the engine and wrapper traces')
}
for (const stage of ['decision', 'log']) {
  events.length = 0
  failAt = stage
  await rejects(() => api.hasPermissionsToUseTool(tool as never, input, context as never, assistant as never, 'call'), { message: stage }, 'hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must let a failure of the decision or the log reach the caller')
  equal(events.length, stage === 'decision' ? 1 : 2, 'hasPermissionsToUseTool in src/permissions/rules/permissionDoor.ts must log only after the decision, and must not repeat either step')
}
console.log('PASS: rule batches, duplicate clears, deletion effects, decision identity, logs and failure propagation')
