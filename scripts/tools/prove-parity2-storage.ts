#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-storage-'))
const home = join(SCRATCH, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

{
  const { enableConfigs, saveGlobalConfig, getGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  t('a fresh config starts with no panel open', getDefaultAppState().expandedView === 'none')
  saveGlobalConfig(current => ({ ...current, expandedView: 'tasks' }))
  t('the saved panel is read back', getGlobalConfig().expandedView === 'tasks')
  t('a relaunch seeds the default state from the remembered panel', getDefaultAppState().expandedView === 'tasks')
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
