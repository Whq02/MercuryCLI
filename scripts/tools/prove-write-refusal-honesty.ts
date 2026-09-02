#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'write-refusal-')))
const PROJ = join(SCRATCH, 'proj')
mkdirSync(PROJ, { recursive: true })
process.chdir(PROJ)
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createPathChecker } = await import('../../src/tools/BashTool/pathValidation.ts')
const { getOriginalCwd } = await import('../../src/utils/cwd.ts')

const context = { ...getDefaultAppState().toolPermissionContext, mode: 'default' as const }
const cwd = getOriginalCwd()
check('fixture: the original cwd is the scratch project', cwd === PROJ, `${cwd} vs ${PROJ}`)
const touch = createPathChecker('touch')

console.log('[1] a create INSIDE the working directory, default mode')
{
  const verdict = touch(['denied-probe.txt'], cwd, context)
  check('the create asks (no grant covers it)', verdict.behavior === 'ask', verdict.behavior)
  check('the reason names the permission mode and the approval road', /needs approval to create/.test(verdict.message) && /permission mode/.test(verdict.message) && /Approve it on its permission card/.test(verdict.message), verdict.message)
  check('…and NEVER calls an inside path outside', !/is outside it/.test(verdict.message), verdict.message)
  check('the refused path is the resolved inside path', verdict.message.includes(join(PROJ, 'denied-probe.txt')), verdict.message)
}

console.log('[2] a create OUTSIDE the working directory')
{
  const outside = join(SCRATCH, 'elsewhere', 'probe.txt')
  const verdict = touch([outside], cwd, context)
  check('the create asks', verdict.behavior === 'ask', verdict.behavior)
  check('the geometry sentence stands for a real outside target', /may only create inside the working directory/.test(verdict.message) && /is outside it/.test(verdict.message), verdict.message)
}

console.log('[3] the read road is untouched')
{
  const verdict = createPathChecker('cat')(['README.md'], cwd, context)
  check('an inside read passes through', verdict.behavior === 'passthrough', `${verdict.behavior}: ${verdict.message}`)
}

console.log(failures === 0 ? '\n ✅ WRITE REFUSAL HONESTY — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
