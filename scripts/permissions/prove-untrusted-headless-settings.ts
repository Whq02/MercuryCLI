#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const { getEnabledSettingSources, isSettingSourceEnabled } = await import(join(SRC, 'utils/settings/constants.ts'))
const { resetTrustDialogAcceptedCacheForTesting, untrustedWorkspaceHeadless } = await import(join(SRC, 'utils/config/trust.ts'))
const state = await import(join(SRC, 'bootstrap/state.ts'))
enableConfigs()

console.log('============================================================')
console.log(' a headless run in a folder nobody trusted reads none of that folder\'s settings')
console.log('============================================================')

section('§0 the page: docs/TRUST.md says a headless run in an untrusted folder keeps the user\'s own configuration and managed policy')
{
  const page = readFileSync(join(ROOT, 'docs', 'TRUST.md'), 'utf8')
  check('the page says nothing a workspace config file asked for executes before trust', /Until you grant trust for\s+the directory, nothing a workspace config file asked for gets to execute/.test(page))
  check('the page says the user\'s own configuration and managed policy still apply there', /The user's\s+own configuration and managed policy still apply/.test(page))
}

section('§1 a window, where the trust card stands before anything runs, keeps every allowed layer')
state.setSessionTrustAccepted(false)
resetTrustDialogAcceptedCacheForTesting()
state.setIsInteractive(true)
{
  const sources = getEnabledSettingSources()
  check('the window is not the untrusted headless case', untrustedWorkspaceHeadless() === false)
  check('its enabled layers hold the project and local layers', sources.includes('projectSettings') && sources.includes('localSettings') && sources.includes('userSettings'), sources.join(','))
}

section('§2 a headless run in a folder with no trust grant')
state.setIsInteractive(false)
{
  const sources = getEnabledSettingSources()
  check('the run is the untrusted headless case (this scratch home holds no grant)', untrustedWorkspaceHeadless() === true)
  check('its enabled layers are the user, flag and policy layers alone', sources.join(',') === 'userSettings,flagSettings,policySettings', sources.join(','))
  check('the project layer and the local layer each read as not enabled', !isSettingSourceEnabled('projectSettings') && !isSettingSourceEnabled('localSettings') && isSettingSourceEnabled('userSettings'))
}

section('§3 --config-layers still narrows what is left')
{
  const before = state.getAllowedSettingSources()
  state.setAllowedSettingSources(['projectSettings', 'localSettings'])
  const sources = getEnabledSettingSources()
  check('with the user layer taken out by the flag, only flag and policy remain', sources.join(',') === 'flagSettings,policySettings', sources.join(','))
  state.setAllowedSettingSources(before)
}

section('§4 the same run once the folder is trusted')
state.setSessionTrustAccepted(true)
{
  const sources = getEnabledSettingSources()
  check('the run is no longer the untrusted headless case', untrustedWorkspaceHeadless() === false)
  check('its enabled layers hold the project and local layers again', sources.includes('projectSettings') && sources.includes('localSettings') && sources.includes('userSettings'), sources.join(','))
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ untrusted headless settings: ${checks} checks, 0 failures` : ` ❌ untrusted headless settings: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
