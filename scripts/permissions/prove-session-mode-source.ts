#!/usr/bin/env bun
// gate-watch: src/utils/permissions/permissionSetup.ts src/components/Settings/Config.tsx
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const HOME = mkdtempSync(join(tmpdir(), 'session-mode-source-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const setup = await import('../../src/utils/permissions/permissionSetup.ts')
const modes = await import('../../src/utils/permissions/PermissionMode.ts')
const settings = await import('../../src/utils/settings/settings.ts')

const seedSettings = (mode: string | undefined): void => {
  const written = settings.updateSettingsForSource('userSettings', { guardrails: { mode } } as never)
  if (written.error !== null) throw new Error(`seed ${String(mode)}: ${String(written.error)}`)
}

section('§1 the resolver names the source, every arm of the order')
{
  seedSettings(undefined)
  const byFlag = setup.resolveSessionPermissionMode({ dangerouslySkipPermissions: true })
  check('--sovereign composes sovereign from the launch flag', byFlag.mode === 'sovereign' && byFlag.source === 'launch-flag', JSON.stringify(byFlag))
  const byEnv = setup.resolveSessionPermissionMode({ dangerouslySkipPermissions: true, envBypassArmed: true })
  check('the env standing consent composes sovereign and names the session birth', byEnv.mode === 'sovereign' && byEnv.source === 'session-birth', JSON.stringify(byEnv))
  const byArg = setup.resolveSessionPermissionMode({ permissionModeCli: 'implement', dangerouslySkipPermissions: false })
  check('--mode implement composes implement from the mode argument', byArg.mode === 'implement' && byArg.source === 'mode-argument', JSON.stringify(byArg))
  seedSettings('apollo')
  const bySettings = setup.resolveSessionPermissionMode({ dangerouslySkipPermissions: false })
  check('a saved guardrails.mode composes from your settings', bySettings.mode === 'apollo' && bySettings.source === 'saved-settings', JSON.stringify(bySettings))
  seedSettings(undefined)
  const byNothing = setup.resolveSessionPermissionMode({ dangerouslySkipPermissions: false })
  check('nothing armed composes the default from the default', byNothing.mode === 'default' && byNothing.source === 'default', JSON.stringify(byNothing))
  const legacy = setup.initialPermissionModeFromCLI({ dangerouslySkipPermissions: true })
  check('initialPermissionModeFromCLI keeps its shape (mode + optional notification, no source required)', legacy.mode === 'sovereign' && legacy.notification === undefined, JSON.stringify(legacy))
  seedSettings('sovereign')
  const refused = setup.initialPermissionModeFromCLI({ dangerouslySkipPermissions: false })
  check('a saved sovereign without the launch flag still falls to default with the one sentence', refused.mode === 'default' && (refused.notification ?? '').includes('requires launching with --sovereign'), JSON.stringify(refused))
  seedSettings(undefined)
}

section('§1b a typed --mode outranks the Boot Menu\'s standing consent (the Air\'s mercury --mode flow opened in sovereign mode)')
{
  seedSettings(undefined)
  const typedFlow = setup.resolveSessionPermissionMode({ permissionModeCli: 'flow', dangerouslySkipPermissions: true, envBypassArmed: true })
  check('--mode flow with the Sovereign mode row saved composes flow from the mode argument', typedFlow.mode === 'flow' && typedFlow.source === 'mode-argument', JSON.stringify(typedFlow))
  check('…with no refusal line: nothing was refused', typedFlow.notification === undefined, JSON.stringify(typedFlow))
  check('/config names the source: the mode argument', setup.describeSessionPermissionMode(typedFlow) === `${modes.permissionModeTitle('flow')} · from ${setup.sessionPermissionModeSourceWords('mode-argument')}`, setup.describeSessionPermissionMode(typedFlow))
  const typedDefault = setup.resolveSessionPermissionMode({ permissionModeCli: 'default', dangerouslySkipPermissions: true, envBypassArmed: true })
  check('--mode default with the row saved composes default from the mode argument', typedDefault.mode === 'default' && typedDefault.source === 'mode-argument', JSON.stringify(typedDefault))
  const typedSovereign = setup.resolveSessionPermissionMode({ permissionModeCli: 'sovereign', dangerouslySkipPermissions: true, envBypassArmed: true })
  check('--mode sovereign with the row saved is sovereign with no line', typedSovereign.mode === 'sovereign' && typedSovereign.notification === undefined, JSON.stringify(typedSovereign))
  const bare = setup.resolveSessionPermissionMode({ dangerouslySkipPermissions: true, envBypassArmed: true })
  check('no --mode with the row saved is still born sovereign from the standing consent', bare.mode === 'sovereign' && bare.source === 'session-birth' && bare.notification === undefined, JSON.stringify(bare))
  const flagged = setup.resolveSessionPermissionMode({ permissionModeCli: 'flow', dangerouslySkipPermissions: false })
  check('--mode flow with nothing armed carries no line', flagged.mode === 'flow' && flagged.notification === undefined, JSON.stringify(flagged))
  process.env.MERCURY_SKIP_PERMISSIONS = '1'
  const second = setup.initialPermissionModeFromCLI({ permissionModeCli: 'flow', dangerouslySkipPermissions: false })
  check('the boot\'s second resolution (the mode already flow, the env row still set) stays flow', second.mode === 'flow' && second.notification === undefined, JSON.stringify(second))
  delete process.env.MERCURY_SKIP_PERMISSIONS
}

section('§2 the composed read answers the field question')
{
  seedSettings(undefined)
  const fieldCase = setup.resolveSessionPermissionMode({ dangerouslySkipPermissions: true, envBypassArmed: true })
  const words = setup.describeSessionPermissionMode(fieldCase)
  check('a session born sovereign via standing consent reads Sovereign Mode, never Default', fieldCase.mode === 'sovereign' && words.startsWith(modes.permissionModeTitle('sovereign')), words)
  check('the words name where the mode came from', words.includes(setup.sessionPermissionModeSourceWords(fieldCase.source)), words)
  const saved = setup.resolveSessionPermissionMode({ dangerouslySkipPermissions: false })
  const savedWords = setup.describeSessionPermissionMode(saved)
  check('a plain session composes its own honest line', savedWords === `${modes.permissionModeTitle(saved.mode)} · from ${setup.sessionPermissionModeSourceWords(saved.source)}`, savedWords)
}

section('§3 the words stay inside the mode vocabulary')
{
  for (const source of ['launch-flag', 'mode-argument', 'saved-settings', 'session-birth', 'default'] as const) {
    const words = setup.sessionPermissionModeSourceWords(source)
    check(`the source words for ${source} are plain`, words.length > 0 && !/[▮⊠⏵◆]/.test(words), words)
  }
  for (const mode of modes.PERMISSION_MODES) {
    const line = setup.describeSessionPermissionMode({ mode, source: 'saved-settings' })
    check(`${mode} words carry its own title`, line.startsWith(modes.permissionModeTitle(mode)), line)
  }
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-session-mode-source: all green' : `\nprove-session-mode-source: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
