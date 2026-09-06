#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(join(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'env-switches-'))
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const off = (name: string): void => { process.env[name] = '0' }
const unset = (name: string): void => { delete process.env[name] }
const src = (rel: string): string => readFileSync(rel, 'utf8')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { flagEnabled } = await import('../../src/substrate/flagRegistry.ts')
const { getAutoUpdaterDisabledReason } = await import('../../src/utils/config/derived.ts')
const { getPrivacyLevel } = await import('../../src/utils/privacyLevel.ts')
const { getPromptCachingEnabled } = await import('../../src/services/providers/anthropic/requestParams.ts')
const { getSmallFastModel, getDefaultSonnetModel, getDefaultOpusModel } = await import('../../src/utils/model/model.ts')
const { isAutoCompactEnabled } = await import('../../src/services/compact/autoCompact.ts')
const feedback = (await import('../../src/commands/feedback/index.ts')).default as { isEnabled?: () => boolean }
const health = (await import('../../src/commands/health/index.ts')).default as { isEnabled?: () => boolean }
const login = ((await import('../../src/commands/login/index.ts')).default as () => { isEnabled?: () => boolean })()
const logout = (await import('../../src/commands/logout/index.ts')).default as { isEnabled?: () => boolean }

const SWITCHES = ['MERCURY_AUTOUPDATE', 'MERCURY_TELEMETRY', 'MERCURY_ERROR_REPORTING', 'MERCURY_BUG_COMMAND', 'MERCURY_FEEDBACK_COMMAND', 'MERCURY_DOCTOR_COMMAND', 'MERCURY_LOGIN_COMMAND', 'MERCURY_LOGOUT_COMMAND', 'MERCURY_PROMPT_CACHING', 'MERCURY_PROMPT_CACHING_HAIKU', 'MERCURY_PROMPT_CACHING_SONNET', 'MERCURY_PROMPT_CACHING_OPUS', 'MERCURY_INTERLEAVED_THINKING', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_BUILTIN_RIPGREP', 'MERCURY_MCP_LARGE_OUTPUT_FILES']
for (const name of SWITCHES) unset(name)

section('§1 the registry polarity: unset ⇒ on, =0 ⇒ off, live')
for (const name of SWITCHES) {
  unset(name)
  const on = flagEnabled(name)
  off(name)
  const offNow = flagEnabled(name)
  unset(name)
  check(`${name}: unset on, =0 off`, on === true && offNow === false, `on=${on} off=${offNow}`)
}

section('§2 each switch at its owner')
{
  unset('MERCURY_AUTOUPDATE')
  check('auto-update: unset ⇒ the standalone reason', getAutoUpdaterDisabledReason()?.type === 'standalone')
  off('MERCURY_AUTOUPDATE')
  const reason = getAutoUpdaterDisabledReason()
  check('auto-update: =0 ⇒ the reason names the variable', reason?.type === 'env' && (reason as { envVar?: string }).envVar === 'MERCURY_AUTOUPDATE', JSON.stringify(reason))
  unset('MERCURY_AUTOUPDATE')

  unset('MERCURY_TELEMETRY')
  check('telemetry: unset ⇒ the default privacy level', getPrivacyLevel() === 'default', getPrivacyLevel())
  off('MERCURY_TELEMETRY')
  check('telemetry: =0 ⇒ no-telemetry', getPrivacyLevel() === 'no-telemetry', getPrivacyLevel())
  unset('MERCURY_TELEMETRY')

  check('error reporting: the log suppression reads the switch', /if \(!flagEnabled\('MERCURY_ERROR_REPORTING'\)\) return true/.test(src('src/utils/log.ts')))

  const enabledOf = (c: { isEnabled?: () => boolean }): boolean => (c.isEnabled ? c.isEnabled() : true)
  check('/bug and /feedback: unset ⇒ enabled', enabledOf(feedback) === true)
  off('MERCURY_BUG_COMMAND'); check('/bug: =0 ⇒ the command is gone', enabledOf(feedback) === false); unset('MERCURY_BUG_COMMAND')
  off('MERCURY_FEEDBACK_COMMAND'); check('/feedback: =0 ⇒ the command is gone', enabledOf(feedback) === false); unset('MERCURY_FEEDBACK_COMMAND')
  check('/health: unset ⇒ enabled', enabledOf(health) === true)
  off('MERCURY_DOCTOR_COMMAND'); check('/health: =0 ⇒ gone', enabledOf(health) === false); unset('MERCURY_DOCTOR_COMMAND')
  check('/logins: unset ⇒ enabled', enabledOf(login) === true)
  off('MERCURY_LOGIN_COMMAND'); check('/logins: =0 ⇒ gone', enabledOf(login) === false); unset('MERCURY_LOGIN_COMMAND')
  check('/logout: unset ⇒ enabled', enabledOf(logout) === true)
  off('MERCURY_LOGOUT_COMMAND'); check('/logout: =0 ⇒ gone', enabledOf(logout) === false); unset('MERCURY_LOGOUT_COMMAND')

  const haiku = getSmallFastModel(); const sonnet = getDefaultSonnetModel(); const opus = getDefaultOpusModel()
  check('prompt caching: unset ⇒ on for every tier', getPromptCachingEnabled(haiku) && getPromptCachingEnabled(sonnet) && getPromptCachingEnabled(opus))
  off('MERCURY_PROMPT_CACHING'); check('prompt caching: =0 ⇒ off for every tier', !getPromptCachingEnabled(haiku) && !getPromptCachingEnabled(sonnet) && !getPromptCachingEnabled(opus)); unset('MERCURY_PROMPT_CACHING')
  off('MERCURY_PROMPT_CACHING_HAIKU'); check('haiku caching: =0 ⇒ off on the haiku tier alone', !getPromptCachingEnabled(haiku) && getPromptCachingEnabled(sonnet)); unset('MERCURY_PROMPT_CACHING_HAIKU')
  off('MERCURY_PROMPT_CACHING_SONNET'); check('sonnet caching: =0 ⇒ off on the sonnet tier alone', !getPromptCachingEnabled(sonnet) && getPromptCachingEnabled(opus)); unset('MERCURY_PROMPT_CACHING_SONNET')
  off('MERCURY_PROMPT_CACHING_OPUS'); check('opus caching: =0 ⇒ off on the opus tier alone', !getPromptCachingEnabled(opus) && getPromptCachingEnabled(sonnet)); unset('MERCURY_PROMPT_CACHING_OPUS')

  check('interleaved thinking: the beta builder reads the switch', /flagEnabled\('MERCURY_INTERLEAVED_THINKING'\) &&/.test(src('src/utils/model/capabilities.ts')))

  check('compaction: unset ⇒ the automatic fold is on', isAutoCompactEnabled() === true)
  off('MERCURY_COMPACT'); check('compaction: =0 ⇒ the automatic fold is off', isAutoCompactEnabled() === false); unset('MERCURY_COMPACT')
  off('MERCURY_AUTO_COMPACT'); check('the automatic fold: =0 ⇒ off', isAutoCompactEnabled() === false); unset('MERCURY_AUTO_COMPACT')

  check('ripgrep: the resolver prefers a PATH ripgrep only at =0', /!flagEnabled\('MERCURY_BUILTIN_RIPGREP'\) && systemRg\(\)/.test(src('src/utils/ripgrep.ts')))
  check('MCP large output files: the truncation branch reads the switch', /!flagEnabled\('MERCURY_MCP_LARGE_OUTPUT_FILES'\)/.test(src('src/services/mcp/client.ts')))
}

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ env switches: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ env switches: every default-on switch reads on unset and off at =0')
