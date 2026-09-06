#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'spelling-rewrite-home-'))
const PROJ = mkdtempSync(join(tmpdir(), 'spelling-rewrite-proj-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const state = await import('../../src/bootstrap/state.ts')
state.setOriginalCwd(PROJ)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'])
const settings = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { rewriteRetiredSettingsSpellings, normalizeToolRuleString, normalizeMatcherSpelling } = await import(
  '../../src/migrations/migrateSettingsSpellings.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const userFile = join(HOME, 'settings.json')
const raw = (): string => readFileSync(userFile, 'utf8')
const parsed = (): Record<string, unknown> => JSON.parse(raw()) as Record<string, unknown>

console.log('L1 retired keys rewrite on first read')
{
  writeFileSync(
    userFile,
    JSON.stringify(
      {
        permissions: { allow: ['Read'], disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable' },
        skipDangerousModePermissionPrompt: true,
        autoDreamEnabled: false,
        showClearContextOnPlanAccept: true,
        theme: 'dark',
      },
      null,
      2,
    ),
  )
  resetSettingsCache()
  const read = settings.getSettingsForSource('userSettings') as Record<string, unknown>
  const perms = read.permissions as Record<string, unknown>
  check('permissions.disableSovereignMode reads true', perms.disableSovereignMode === true, JSON.stringify(perms))
  check('permissions.disableFlowMode reads true', perms.disableFlowMode === true)
  check('skipSovereignConsentPrompt carried', read.skipSovereignConsentPrompt === true)
  check('memoryUpkeepEnabled carried (false stays false)', read.memoryUpkeepEnabled === false)
  check('showClearContextOnStrategyAccept carried', read.showClearContextOnStrategyAccept === true)
  const disk = parsed()
  const diskPerms = disk.permissions as Record<string, unknown>
  check(
    'the file on disk carries the new keys and none of the retired ones',
    diskPerms.disableSovereignMode === true &&
      diskPerms.disableFlowMode === true &&
      !('disableBypassPermissionsMode' in diskPerms) &&
      !('disableAutoMode' in diskPerms) &&
      !('disableAutoMode' in disk) &&
      disk.skipSovereignConsentPrompt === true &&
      !('skipDangerousModePermissionPrompt' in disk) &&
      disk.memoryUpkeepEnabled === false &&
      !('autoDreamEnabled' in disk) &&
      disk.showClearContextOnStrategyAccept === true &&
      !('showClearContextOnPlanAccept' in disk),
    raw(),
  )
  check('unrelated keys survive the rewrite', disk.theme === 'dark' && JSON.stringify(diskPerms.allow) === '["Read"]')
  check(
    "a value other than the literal 'disable' is dropped, never carried as true",
    JSON.stringify(rewriteRetiredSettingsSpellings({ permissions: { disableBypassPermissionsMode: 'maybe' } })) === '{"permissions":{}}',
  )
  check(
    'a current key already present wins over the retired one',
    JSON.stringify(rewriteRetiredSettingsSpellings({ autoDreamEnabled: true, memoryUpkeepEnabled: false })) === '{"memoryUpkeepEnabled":false}',
  )
}

console.log('L2 tool names in rules, matchers and if-conditions')
{
  writeFileSync(
    userFile,
    JSON.stringify(
      {
        permissions: { allow: ['Task', 'ListMcpResourcesTool(server-a)', 'contract'], deny: ['KillShell'], ask: ['ExitPlanMode'] },
        hooks: {
          PreToolUse: [
            { matcher: 'Task|ReadMcpResourceTool', hooks: [{ type: 'command', command: 'echo hi', if: 'EnterPlanMode' }] },
            { matcher: '^Bash.*$', hooks: [{ type: 'command', command: 'echo re' }] },
          ],
        },
      },
      null,
      2,
    ),
  )
  resetSettingsCache()
  const read = settings.getSettingsForSource('userSettings') as Record<string, unknown>
  const perms = read.permissions as { allow: string[]; deny: string[]; ask: string[] }
  check('allow rules rewritten', JSON.stringify(perms.allow) === '["Agent","ListMcpResources(server-a)","Contract"]', JSON.stringify(perms.allow))
  check('deny and ask rules rewritten', perms.deny[0] === 'TaskStop' && perms.ask[0] === 'ExitStrategyMode')
  const hooks = (read.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ if?: string }> }> }).PreToolUse
  check('a plain-name matcher is rewritten name by name', hooks[0]?.matcher === 'Agent|ReadMcpResource', hooks[0]?.matcher)
  check("a hook's if-condition is rewritten", hooks[0]?.hooks[0]?.if === 'EnterStrategyMode')
  check('a regular-expression matcher is left as it is', hooks[1]?.matcher === '^Bash.*$')
  check('the file on disk carries the rewritten names', !raw().includes('KillShell') && raw().includes('TaskStop'))
  check('normalizeToolRuleString keeps escaped content intact', normalizeToolRuleString('Task(a \\(b\\))') === 'Agent(a \\(b\\))')
  check('normalizeMatcherSpelling leaves an unknown name alone', normalizeMatcherSpelling('Edit|Other') === 'Edit|Other')
}

console.log('L3 a second read is a byte no-op; a fresh file is untouched')
{
  const before = raw()
  resetSettingsCache()
  settings.getSettingsForSource('userSettings')
  check('a second read changes no byte', raw() === before)
  const fresh = JSON.stringify({ permissions: { allow: ['Read'], disableSovereignMode: true }, memoryUpkeepEnabled: true }, null, 2)
  writeFileSync(userFile, fresh)
  resetSettingsCache()
  settings.getSettingsForSource('userSettings')
  check('a fresh file with current spellings is left byte-identical', raw() === fresh)
}

console.log('L4 a file that cannot be rewritten is read as its current spellings with a named warning')
{
  const locked = join(HOME, 'locked')
  mkdirSync(locked)
  const lockedFile = join(locked, 'settings.json')
  writeFileSync(lockedFile, JSON.stringify({ skipDangerousModePermissionPrompt: true }))
  chmodSync(locked, 0o555)
  try {
    const result = settings.parseSettingsFile(lockedFile)
    check('the current spelling is read for this run', result.settings?.skipSovereignConsentPrompt === true, JSON.stringify(result.settings))
    check(
      'the rename is named as a warning',
      result.errors.some(e => e.severity === 'warning' && /retired settings spellings could not be rewritten/.test(e.message)),
      JSON.stringify(result.errors),
    )
    check('the file itself is untouched', readFileSync(lockedFile, 'utf8').includes('skipDangerousModePermissionPrompt'))
  } finally {
    chmodSync(locked, 0o755)
  }
}

console.log(failures === 0 ? '\n ✅ SETTINGS SPELLING REWRITE — once, in place, named when it cannot' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
