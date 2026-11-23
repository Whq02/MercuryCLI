#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launchDir = process.cwd()
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'permission-rule-case-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'permission-rule-case-proj-')))
const USER = realpathSync(mkdtempSync(join(tmpdir(), 'permission-rule-case-user-')))
mkdirSync(join(PROJ, 'secrets'), { recursive: true })
writeFileSync(join(PROJ, 'secrets', 'key.txt'), 'k')
mkdirSync(join(USER, '.ssh'), { recursive: true })
writeFileSync(join(USER, '.ssh', 'id_rsa'), 'k')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.HOME = USER
process.env.USERPROFILE = USER
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(PROJ)

const { matchingRuleForInput, checkReadPermissionForTool, checkWritePermissionForTool, relativePath } = await import(
  '../../src/permissions/rules/filesystem.ts'
)
type Ctx = import('../../src/permissions/rules/permissionDoor.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' -- ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const windows = process.platform === 'win32'
const ctx = (deny: string[], mode = 'default'): Ctx =>
  ({
    mode,
    alwaysDenyRules: { session: deny },
    alwaysAllowRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  }) as unknown as Ctx
const readTool = { name: 'Read', getPath: (i: { file_path: string }) => i.file_path } as never
const editTool = { name: 'Edit', getPath: (i: { file_path: string }) => i.file_path } as never

const secret = join(PROJ, 'secrets', 'key.txt')
const sshKey = join(USER, '.ssh', 'id_rsa')

console.log('============================================================')
console.log(' file permission rules and the case of a Windows path')
console.log('============================================================')

section('§1 the spelling on disk (every platform)')
check('Read(secrets/**) matches the file as spelled', matchingRuleForInput(secret, ctx(['Read(secrets/**)']), 'read', 'deny') !== null, '', 'matchingRuleForInput in src/permissions/rules/filesystem.ts did not match a project-relative deny rule against the file path as spelled')
check('the Read verdict is deny', checkReadPermissionForTool(readTool, { file_path: secret }, ctx(['Read(secrets/**)'])).behavior === 'deny', '', 'checkReadPermissionForTool in src/permissions/rules/filesystem.ts must return deny when a Read deny rule matches')
check('the Edit verdict is deny in implement mode', checkWritePermissionForTool(editTool, { file_path: secret }, ctx(['Edit(secrets/**)'], 'implement')).behavior === 'deny', '', 'checkWritePermissionForTool in src/permissions/rules/filesystem.ts must return deny when an Edit deny rule matches, even in implement mode')
check('Read(~/.ssh/**) matches the key as spelled', matchingRuleForInput(sshKey, ctx(['Read(~/.ssh/**)']), 'read', 'deny') !== null, '', 'matchingRuleForInput in src/permissions/rules/filesystem.ts did not expand ~ in a deny rule to the home folder')

if (windows) {
  section('§2 the same files in another case (Windows opens them all)')
  for (const [name, spelled] of [['upper', secret.toUpperCase()], ['lower', secret.toLowerCase()]] as const) {
    check(`Read(secrets/**) matches the ${name}-case spelling`, matchingRuleForInput(spelled, ctx(['Read(secrets/**)']), 'read', 'deny') !== null, '', 'rule matching in src/permissions/rules/filesystem.ts must compare Windows paths without regard to case')
    const read = checkReadPermissionForTool(readTool, { file_path: spelled }, ctx(['Read(secrets/**)']))
    check(`the Read verdict for the ${name}-case spelling is deny`, read.behavior === 'deny', read.behavior, 'checkReadPermissionForTool in src/permissions/rules/filesystem.ts must match deny rules without regard to path case on Windows')
    const edit = checkWritePermissionForTool(editTool, { file_path: spelled }, ctx(['Edit(secrets/**)'], 'implement'))
    check(`the Edit verdict for the ${name}-case spelling is deny in implement mode`, edit.behavior === 'deny', edit.behavior, 'checkWritePermissionForTool in src/permissions/rules/filesystem.ts must match deny rules without regard to path case on Windows')
  }
  check('Read(~/.ssh/**) matches the lower-case spelling of the key', matchingRuleForInput(sshKey.toLowerCase(), ctx(['Read(~/.ssh/**)']), 'read', 'deny') !== null, '', 'the home-relative deny rule must also match a lower-case spelling on Windows; see matchingRuleForInput in src/permissions/rules/filesystem.ts')
  check('relativePath keeps the target spelling below a common prefix that differs in case', relativePath('C:\\Work\\Proj', 'c:\\work\\proj\\Sub\\File.ts') === 'Sub/File.ts', relativePath('C:\\Work\\Proj', 'c:\\work\\proj\\Sub\\File.ts'), 'relativePath in src/permissions/rules/filesystem.ts must compare the common prefix without regard to case and return the rest as the target spells it')
} else {
  section('§2 POSIX keeps case-sensitive segments')
  check('relativePath treats a different case as a different directory', relativePath('/work/Proj', '/work/proj/File.ts').startsWith('..'), '', 'relativePath in src/permissions/rules/filesystem.ts must stay case-sensitive on POSIX')
}

process.chdir(launchDir)
for (const dir of [PROJ, USER, HOME]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
  }
}
console.log(failures === 0 ? '\nALL PERMISSION RULE CASE CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
