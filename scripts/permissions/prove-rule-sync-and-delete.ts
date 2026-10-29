#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const launchDir = process.cwd()
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'rule-sync-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'rule-sync-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.chdir(PROJ)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { applyPermissionRulesToPermissionContext, deletePermissionRule, syncPermissionRulesFromDisk } = await import('../../src/utils/permissions/permissions.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { setCachedSettingsForSource } = await import('../../src/utils/settings/settingsCache.ts')
const { getSettingsFilePathForSource } = await import('../../src/utils/settings/settings.ts')
type Rule = import('../../src/types/permissions.ts').PermissionRule
type Ctx = import('../../src/types/permissions.ts').ToolPermissionContext

const rule = (source: Rule['source'], ruleBehavior: Rule['ruleBehavior'], toolName: string, ruleContent?: string): Rule => ({
  source,
  ruleBehavior,
  ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent },
})
const rulesOf = (ctx: Ctx, behavior: 'allow' | 'deny' | 'ask', source: Rule['source']): string[] =>
  ({ allow: ctx.alwaysAllowRules, deny: ctx.alwaysDenyRules, ask: ctx.alwaysAskRules })[behavior][source] ?? []

section('§1 adding rules groups them by source and behaviour, in first-seen order, values in input order')
{
  const added = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), [
    rule('userSettings', 'allow', 'Bash', 'ls *'),
    rule('session', 'deny', 'Bash', 'rm *'),
    rule('userSettings', 'allow', 'Read'),
    rule('userSettings', 'ask', 'Bash', 'git push *'),
    rule('session', 'deny', 'WebFetch'),
  ])
  check('the user allow group keeps both values in input order', j(rulesOf(added, 'allow', 'userSettings')) === j(['Bash(ls *)', 'Read']), j(added.alwaysAllowRules))
  check('the session deny group keeps both values in input order', j(rulesOf(added, 'deny', 'session')) === j(['Bash(rm *)', 'WebFetch']), j(added.alwaysDenyRules))
  check('the user ask group holds its one value', j(rulesOf(added, 'ask', 'userSettings')) === j(['Bash(git push *)']), j(added.alwaysAskRules))
  check('no other source gained a row', Object.keys(added.alwaysAllowRules).join(',') === 'userSettings' && Object.keys(added.alwaysDenyRules).join(',') === 'session')
  check('the input context is not mutated', Object.keys(getEmptyToolPermissionContext().alwaysAllowRules).length === 0)
}

section('§2 a sync from disk replaces the three settings sources and leaves the session and cli rules alone')
{
  setCachedSettingsForSource('policySettings', null)
  const before = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), [
    rule('userSettings', 'allow', 'Bash', 'old *'),
    rule('projectSettings', 'deny', 'Read'),
    rule('localSettings', 'ask', 'Write'),
    rule('cliArg', 'allow', 'Glob'),
    rule('session', 'deny', 'Grep'),
  ])
  const synced = syncPermissionRulesFromDisk(before, [rule('userSettings', 'allow', 'Bash', 'new *'), rule('projectSettings', 'allow', 'Edit')])
  check('the stale user allow rule is gone and the fresh one stands', j(rulesOf(synced, 'allow', 'userSettings')) === j(['Bash(new *)']), j(synced.alwaysAllowRules))
  check('the project deny rule was cleared (nothing on disk names it)', rulesOf(synced, 'deny', 'projectSettings').length === 0, j(synced.alwaysDenyRules))
  check('the local ask rule was cleared', rulesOf(synced, 'ask', 'localSettings').length === 0, j(synced.alwaysAskRules))
  check('the project allow rule from disk stands', j(rulesOf(synced, 'allow', 'projectSettings')) === j(['Edit']))
  check('the cli and session rules survive a plain sync', j(rulesOf(synced, 'allow', 'cliArg')) === j(['Glob']) && j(rulesOf(synced, 'deny', 'session')) === j(['Grep']), j(synced.alwaysAllowRules))

  setCachedSettingsForSource('policySettings', { guardrails: { managedOnly: true } } as never)
  const managed = syncPermissionRulesFromDisk(before, [rule('policySettings', 'deny', 'Bash', 'sudo *')])
  check('under managed-only the cli and session rules are cleared too', rulesOf(managed, 'allow', 'cliArg').length === 0 && rulesOf(managed, 'deny', 'session').length === 0, j(managed.alwaysAllowRules))
  check('under managed-only the policy rule from disk stands', j(rulesOf(managed, 'deny', 'policySettings')) === j(['Bash(sudo *)']), j(managed.alwaysDenyRules))
  setCachedSettingsForSource('policySettings', null)
}

section('§3 deleting a rule: read-only sources refuse, session rules leave the context, settings rules leave the file too')
{
  const pushed: Ctx[] = []
  const setter = (ctx: Ctx): void => {
    pushed.push(ctx)
  }
  for (const source of ['policySettings', 'flagSettings', 'command'] as const) {
    let refused = false
    try {
      await deletePermissionRule({ rule: rule(source, 'deny', 'Bash'), initialContext: getEmptyToolPermissionContext(), setToolPermissionContext: setter })
    } catch {
      refused = true
    }
    check(`a ${source} rule cannot be deleted and nothing is pushed`, refused && pushed.length === 0)
  }
  const sessionCtx = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), [rule('session', 'allow', 'Bash', 'ls *'), rule('session', 'allow', 'Read')])
  await deletePermissionRule({ rule: rule('session', 'allow', 'Bash', 'ls *'), initialContext: sessionCtx, setToolPermissionContext: setter })
  check('a session rule is removed from the pushed context and its sibling stays', pushed.length === 1 && j(rulesOf(pushed[0]!, 'allow', 'session')) === j(['Read']), j(pushed[0]?.alwaysAllowRules))

  const userFile = getSettingsFilePathForSource('userSettings')!
  mkdirSync(join(userFile, '..'), { recursive: true })
  writeFileSync(userFile, JSON.stringify({ guardrails: { allow: ['Bash(ls *)', 'Read'] } }, null, 2))
  setCachedSettingsForSource('userSettings', { guardrails: { allow: ['Bash(ls *)', 'Read'] } } as never)
  const userCtx = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), [rule('userSettings', 'allow', 'Bash', 'ls *'), rule('userSettings', 'allow', 'Read')])
  await deletePermissionRule({ rule: rule('userSettings', 'allow', 'Bash', 'ls *'), initialContext: userCtx, setToolPermissionContext: setter })
  const onDisk = JSON.parse(readFileSync(userFile, 'utf8')) as { guardrails?: { allow?: string[] } }
  check('a user-settings rule leaves the settings file', j(onDisk.guardrails?.allow) === j(['Read']), readFileSync(userFile, 'utf8'))
  check('and the pushed context no longer carries it', pushed.length === 2 && j(rulesOf(pushed[1]!, 'allow', 'userSettings')) === j(['Read']), j(pushed[1]?.alwaysAllowRules))
}

process.chdir(launchDir)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-rule-sync-and-delete: ALL PASS' : `\nprove-rule-sync-and-delete: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
