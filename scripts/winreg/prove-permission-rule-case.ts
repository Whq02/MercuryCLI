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
  '../../src/utils/permissions/filesystem.ts'
)
type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const MATCH_FIX = 'change matchingRuleForInput in src/utils/permissions/filesystem.ts'
const READ_FIX = 'change checkReadPermissionForTool in src/utils/permissions/filesystem.ts'
const WRITE_FIX = 'change checkWritePermissionForTool in src/utils/permissions/filesystem.ts'
const RELATIVE_FIX = 'change relativePath in src/utils/permissions/filesystem.ts'
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
check('Read(secrets/**) matches the file as spelled', matchingRuleForInput(secret, ctx(['Read(secrets/**)']), 'read', 'deny') !== null, 'a deny rule no longer matches the file path as spelled; ' + MATCH_FIX)
check('the Read verdict is deny', checkReadPermissionForTool(readTool, { file_path: secret }, ctx(['Read(secrets/**)'])).behavior === 'deny', 'the deny rule did not turn the read into a deny; ' + READ_FIX)
check('the Edit verdict is deny in implement mode', checkWritePermissionForTool(editTool, { file_path: secret }, ctx(['Edit(secrets/**)'], 'implement')).behavior === 'deny', 'the deny rule did not turn the edit into a deny; ' + WRITE_FIX)
check('Read(~/.ssh/**) matches the key as spelled', matchingRuleForInput(sshKey, ctx(['Read(~/.ssh/**)']), 'read', 'deny') !== null, 'a home-relative deny rule no longer matches the key as spelled; ' + MATCH_FIX)

if (windows) {
  section('§2 the same files in another case (Windows opens them all)')
  for (const [name, spelled] of [['upper', secret.toUpperCase()], ['lower', secret.toLowerCase()]] as const) {
    check(`Read(secrets/**) matches the ${name}-case spelling`, matchingRuleForInput(spelled, ctx(['Read(secrets/**)']), 'read', 'deny') !== null, 'the rule match must ignore path case on Windows; ' + MATCH_FIX)
    const read = checkReadPermissionForTool(readTool, { file_path: spelled }, ctx(['Read(secrets/**)']))
    check(`the Read verdict for the ${name}-case spelling is deny`, read.behavior === 'deny', read.behavior + ' · the read check must deny a path spelled in another case on Windows; ' + READ_FIX)
    const edit = checkWritePermissionForTool(editTool, { file_path: spelled }, ctx(['Edit(secrets/**)'], 'implement'))
    check(`the Edit verdict for the ${name}-case spelling is deny in implement mode`, edit.behavior === 'deny', edit.behavior + ' · the write check must deny a path spelled in another case on Windows; ' + WRITE_FIX)
  }
  check('Read(~/.ssh/**) matches the lower-case spelling of the key', matchingRuleForInput(sshKey.toLowerCase(), ctx(['Read(~/.ssh/**)']), 'read', 'deny') !== null, 'the home-relative rule match must ignore path case on Windows; ' + MATCH_FIX)
  check('relativePath keeps the target spelling below a common prefix that differs in case', relativePath('C:\\Work\\Proj', 'c:\\work\\proj\\Sub\\File.ts') === 'Sub/File.ts', relativePath('C:\\Work\\Proj', 'c:\\work\\proj\\Sub\\File.ts') + ' · ' + RELATIVE_FIX)
} else {
  section('§2 POSIX keeps case-sensitive segments')
  check('relativePath treats a different case as a different directory', relativePath('/work/Proj', '/work/proj/File.ts').startsWith('..'), 'on POSIX a different case must stay a different directory; ' + RELATIVE_FIX)
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
