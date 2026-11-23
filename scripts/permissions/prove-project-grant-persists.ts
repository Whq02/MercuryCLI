#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slashed } from '../lib/platformPath.ts'

const launchDir = process.cwd()
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'grant-persist-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'grant-persist-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
process.chdir(PROJ)

const { checkParsedPaths: checkPathConstraints } = await import('../bash/floor-proof-helpers.ts')
const { persistPermissionUpdate, createEditRuleSuggestion } = await import('../../src/permissions/rules/permissionUpdate.ts')
type Ctx = import('../../src/permissions/rules/permissionDoor.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  const failHint = ' — change checkPathConstraints in src/tools/shell/pathValidation.ts (the minted suggestion and its destination) or persistPermissionUpdate and createEditRuleSuggestion in src/permissions/rules/permissionUpdate.ts (the rule written to .mercury/settings.local.json)'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : failHint}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const emptyCtx = (): Ctx =>
  ({ mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() }) as unknown as Ctx

const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'grant-persist-out-')))

section('§1 THE MINTED DESTINATION')
{
  const result = (await checkPathConstraints({ command: `touch ${slashed(join(OUTSIDE, 't.txt'))}` }, PROJ, emptyCtx())) as {
    suggestions?: Array<{ type: string; destination?: string; directories?: string[] }>
  }
  const dirSuggestion = (result.suggestions ?? []).find(s => s.type === 'addRules')
  check('the directory suggestion exists', dirSuggestion !== undefined, JSON.stringify(result.suggestions))
  check(
    "and carries the localSettings destination (FC-060: 'in this project' persists)",
    dirSuggestion?.destination === 'localSettings',
    dirSuggestion?.destination,
  )
}

section('§2 THE PERSISTED WRITE')
{
  const grant = createEditRuleSuggestion(OUTSIDE, 'localSettings')!
  persistPermissionUpdate(grant)
  const written = JSON.parse(readFileSync(join(PROJ, '.mercury', 'settings.local.json'), 'utf8')) as {
    guardrails?: { allow?: string[]; additionalDirectories?: unknown }
  }
  check(
    'the ordinary Edit rule lands in settings.local.json without another root',
    (written.guardrails?.allow ?? []).includes(`Edit(${process.platform === 'win32' ? `//${OUTSIDE[0]}/${slashed(OUTSIDE.slice(3))}` : `/${OUTSIDE}`}/**)`) && !Object.hasOwn(written.guardrails ?? {}, 'additionalDirectories'),
    JSON.stringify(written.guardrails),
  )
}


process.chdir(launchDir)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
rmSync(OUTSIDE, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-project-grant-persists: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-project-grant-persists: all green')
