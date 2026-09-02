#!/usr/bin/env bun
// prove-project-grant-persists — the "in this project" directory grant
// persists and names its directory (field card FC-060, re-rated S2:
// nothing over-granted; the grant was under-persisted). The Bash card's
// option wrote nothing to any settings file (session destination), so the
// next boot asked the identical question, and the label showed a bare
// basename the operator could not disambiguate.
//
//   §1 the minted suggestions carry the localSettings destination.
//   §2 persistPermissionUpdate lands the directory in settings.local.json.
//   §3 the single-directory label carries the full (middle-truncated) path.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'grant-persist-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'grant-persist-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
process.chdir(PROJ)

const { checkPathConstraints } = await import('../../src/tools/BashTool/pathValidation.ts')
const { persistPermissionUpdate } = await import('../../src/utils/permissions/PermissionUpdate.ts')
type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const emptyCtx = (): Ctx =>
  ({ mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() }) as unknown as Ctx

const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'grant-persist-out-')))

section('§1 THE MINTED DESTINATION')
{
  const result = checkPathConstraints({ command: `touch ${join(OUTSIDE, 't.txt')}` }, PROJ, emptyCtx()) as {
    suggestions?: Array<{ type: string; destination?: string; directories?: string[] }>
  }
  const dirSuggestion = (result.suggestions ?? []).find(s => s.type === 'addDirectories')
  check('the directory suggestion exists', dirSuggestion !== undefined, JSON.stringify(result.suggestions))
  check(
    "and carries the localSettings destination (FC-060: 'in this project' persists)",
    dirSuggestion?.destination === 'localSettings',
    dirSuggestion?.destination,
  )
}

section('§2 THE PERSISTED WRITE')
{
  persistPermissionUpdate({ type: 'addDirectories', destination: 'localSettings', directories: [OUTSIDE] } as never)
  const written = JSON.parse(readFileSync(join(PROJ, '.mercury', 'settings.local.json'), 'utf8')) as {
    permissions?: { additionalDirectories?: string[] }
  }
  check(
    'the directory lands in settings.local.json additionalDirectories',
    (written.permissions?.additionalDirectories ?? []).includes(OUTSIDE),
    JSON.stringify(written.permissions),
  )
}

section('§3 THE LABEL')
{
  const helpers = readFileSync(join(import.meta.dir, '../../src/components/permissions/shellPermissionHelpers.tsx'), 'utf8')
  check('the single-directory label carries the FULL path (middle-truncated)', /singlePathDisplay\(paths\[0\]/.test(helpers))
  check('multi-entry lists keep compact basenames', /paths\.map\(pathDisplayName\)/.test(helpers))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
rmSync(OUTSIDE, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-project-grant-persists: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-project-grant-persists: all green')
