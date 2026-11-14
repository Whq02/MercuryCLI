#!/usr/bin/env bun
import { mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
process.env.MERCURY_WORKTREE_CLONE = 'off'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
delete process.env.MERCURY_HOME
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-copy-holds-back-')))
const fixture = join(scratch, 'repo')
const OWN_HOME = join(fixture, 'node_modules', 'own-home')
mkdirSync(OWN_HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = OWN_HOME

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const realPlatform = process.platform
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let refusing = false
let refusals = 0
Object.defineProperty(process, 'platform', { configurable: true, enumerable: platform.enumerable, get: () => (refusing ? 'win32' : realPlatform) })
mock.module('node:fs/promises', () => ({
  ...fs,
  symlink: async () => {
    refusals++
    refusing = true
    setImmediate(() => {
      refusing = false
    })
    throw Object.assign(new Error('this account may not make a link'), { code: 'EPERM' })
  },
}))

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { applyPermissionRulesToPermissionContext } = await import('../../src/utils/permissions/permissions.ts')
const { loadAllPermissionRulesFromDisk } = await import('../../src/utils/permissions/permissionsLoader.ts')
const { checkReadPermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')
const worktree = await import('../../src/utils/worktree.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
type Made = { worktreePath: string; prepareFailure?: string; ready?: Promise<void> }
const make = (slug: string, options: Record<string, unknown> = {}): Promise<Made> => (worktree.createAgentWorktree as (slug: string, options: unknown) => Promise<Made>)(slug, options)
const prepare = worktree.prepareWorktreeFiles as (repo: string, path: string, from?: string, preserve?: boolean, permission?: unknown, carry?: boolean) => Promise<boolean>

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const kindOf = (path: string): string => {
  try {
    const entry = lstatSync(path)
    return entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'folder' : 'file'
  } catch {
    return 'absent'
  }
}
const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '<absent>'
  }
}
const reader = { name: 'Read', getPath: (input: { file_path: string }): string => input.file_path }
const refused = (context: unknown, path: string): boolean => (checkReadPermissionForTool as (tool: unknown, input: unknown, context: unknown) => { behavior: string })(reader, { file_path: path }, context).behavior === 'deny'
const readContext = (permission: unknown): never =>
  ({
    readFileState: new Map(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }),
    setAppState: () => {},
    messages: [],
    options: { tools: [] },
  }) as never
let reads = 0
const readAnswers = async (path: string, permission: unknown): Promise<string> => {
  reads++
  const tool = FileReadTool as unknown as { validateInput: (input: unknown, context: unknown) => Promise<{ result: boolean; message?: string }>; call: (input: unknown, context: unknown, canUseTool: unknown, parent: unknown) => Promise<{ data: { file?: { content?: unknown } } }> }
  try {
    const valid = await tool.validateInput({ file_path: path }, readContext(permission))
    if (!valid.result) return `refused: ${valid.message ?? ''}`
    const result = await tool.call({ file_path: path }, readContext(permission), null, { uuid: `00000000-0000-0000-0000-${String(reads).padStart(12, '0')}`, message: { id: `msg_copy_${reads}` } })
    return `answered: ${String(result.data.file?.content ?? '')}`
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`
  }
}

const BY_PATH = ['node_modules/private/key.txt', 'node_modules/private/deep/more.txt', 'vendor/pack-secret/marker']
const REFUSED = [...BY_PATH, 'node_modules/mixed/secret.pem', 'node_modules/mixed/inner/also.pem']
const OPEN: Record<string, string> = {
  'node_modules/open/index.js': 'module.exports = "open"\n',
  'node_modules/mixed/ok.js': 'module.exports = "ok"\n',
  'node_modules/mixed/inner/fine.js': 'module.exports = "fine"\n',
  'vendor/pack-open/marker': 'open pack\n',
}
const INSTRUCTIONS = ['node_modules/open/AGENTS.md', 'node_modules/open/MERCURY.md', 'node_modules/mixed/inner/MERCURY.local.md']
const OWN = ['node_modules/own-home/.credentials.json', 'node_modules/own-home/projects/one/session.jsonl']

mkdirSync(join(fixture, 'vendor'), { recursive: true })
git(fixture, 'init', '-q', '-b', 'main')
writeFileSync(join(fixture, '.gitignore'), 'node_modules/\nvendor/*/\n.mercury/\n')
writeFileSync(join(fixture, 'package.json'), '{"name":"copy-holds-back"}\n')
writeFileSync(join(fixture, 'vendor', 'pack-open.lock.json'), '{}\n')
writeFileSync(join(fixture, 'vendor', 'pack-secret.lock.json'), '{}\n')
git(fixture, 'add', '-A')
git(fixture, 'commit', '-q', '-m', 'first')
for (const [file, body] of Object.entries({
  ...OPEN,
  'node_modules/private/key.txt': 'the key\n',
  'node_modules/private/deep/more.txt': 'more of it\n',
  'node_modules/mixed/secret.pem': 'a certificate\n',
  'node_modules/mixed/inner/also.pem': 'another\n',
  'vendor/pack-secret/marker': 'secret pack\n',
  'node_modules/open/AGENTS.md': 'instructions a package ships\n',
  'node_modules/open/MERCURY.md': 'more of them\n',
  'node_modules/mixed/inner/MERCURY.local.md': 'private instructions\n',
  'node_modules/own-home/.credentials.json': '{"token":"secret"}\n',
  'node_modules/own-home/projects/one/session.jsonl': '{}\n',
})) {
  mkdirSync(dirname(join(fixture, file)), { recursive: true })
  writeFileSync(join(fixture, file), body)
}
symlinkSync(join(fixture, 'node_modules', 'private'), join(fixture, 'node_modules', 'alias'), 'junction')
mkdirSync(join(fixture, 'node_modules', '.bin'))
let fileLinks = true
try {
  symlinkSync('../open/index.js', join(fixture, 'node_modules', '.bin', 'tool'), 'file')
  symlinkSync('../private/key.txt', join(fixture, 'node_modules', '.bin', 'key'), 'file')
} catch (error) {
  if (realPlatform !== 'win32' || !['EPERM', 'EACCES'].includes((error as { code?: string }).code ?? '')) throw error
  fileLinks = false
  console.log('  [SKIP] links to files inside the dependency folder: Windows file symlinks require Developer Mode or the symbolic-link privilege')
}
const named = (rel: string): string => (realPlatform === 'win32' ? `Read(${join(fixture, ...rel.split('/'))})` : `Read(/${fixture}/${rel})`)
mkdirSync(join(fixture, '.mercury'), { recursive: true })
writeFileSync(join(fixture, '.mercury', 'settings.json'), JSON.stringify({ guardrails: { deny: [named('node_modules/private/**'), named('vendor/pack-secret/**'), 'Read(**/*.pem)'] } }))

const absent = (copy: string, rels: readonly string[]): string[] => rels.filter(rel => kindOf(join(copy, rel)) !== 'absent')
const roadHolds = async (road: string, copy: string, rules: unknown): Promise<void> => {
  check(`${road}: the dependency folder and the packs are folders of the copy's own, where the link was refused`, kindOf(join(copy, 'node_modules')) === 'folder' && kindOf(join(copy, 'vendor', 'pack-open')) === 'folder', `${kindOf(join(copy, 'node_modules'))}, ${kindOf(join(copy, 'vendor', 'pack-open'))}`)
  check(`${road}: no file a Read rule refuses is in the copy: the folder a rule names whole, a file a pattern names at two depths, a pack named whole`, absent(copy, REFUSED).length === 0, absent(copy, REFUSED).join(', '))
  const answers = await Promise.all(BY_PATH.map(async rel => [rel, await readAnswers(join(copy, rel), rules), await readAnswers(join(copy, dirname(rel), `never-was-there${extname(rel)}`), rules)] as const))
  check(`${road}: a Read of each path the rules name by its place in the checkout answers, at its place in the copy, what a file that was never there answers`, answers.every(([, there, never]) => there === never && never.startsWith('error: ')), answers.filter(([, there, never]) => there !== never).map(([rel, there]) => `${rel}: ${there.slice(0, 60).replace(/\s+/g, ' ')}`).join(' | '))
  check(`${road}: a folder a rule names brings none of its files under the name of a link to it inside the dependency folder`, absent(copy, ['node_modules/alias/key.txt', 'node_modules/alias/deep/more.txt']).length === 0, absent(copy, ['node_modules/alias/key.txt', 'node_modules/alias/deep/more.txt']).join(', '))
  if (fileLinks) check(`${road}: a link to a file a rule names is not copied as that file, and a link to a file no rule names is copied as the file`, kindOf(join(copy, 'node_modules', '.bin', 'key')) === 'absent' && kindOf(join(copy, 'node_modules', '.bin', 'tool')) === 'file' && read(join(copy, 'node_modules', '.bin', 'tool')) === OPEN['node_modules/open/index.js'], `${kindOf(join(copy, 'node_modules', '.bin', 'key'))}, ${kindOf(join(copy, 'node_modules', '.bin', 'tool'))}`)
  check(`${road}: a folder that held one is copied without it`, kindOf(join(copy, 'node_modules', 'mixed')) === 'folder' && kindOf(join(copy, 'node_modules', 'mixed', 'inner')) === 'folder' && read(join(copy, 'node_modules', 'mixed', 'ok.js')) === OPEN['node_modules/mixed/ok.js'])
  check(`${road}: an instruction file inside is left behind`, absent(copy, INSTRUCTIONS).length === 0, absent(copy, INSTRUCTIONS).join(', '))
  check(`${road}: a Mercury home inside is left behind, its credentials and its sessions`, absent(copy, OWN).length === 0, absent(copy, OWN).join(', '))
  check(`${road}: every file no rule names is copied as before, with its content`, Object.entries(OPEN).every(([rel, body]) => read(join(copy, rel)) === body), Object.keys(OPEN).filter(rel => read(join(copy, rel)) !== OPEN[rel]).join(', '))
  check(`${road}: git sees nothing to commit in the copy`, git(copy, 'status', '--porcelain') === '', git(copy, 'status', '--porcelain').slice(0, 200))
}

try {
  process.chdir(fixture)
  state.setOriginalCwd(fixture)
  state.setCwdState(fixture)
  state.setIsInteractive(true)
  config.enableConfigs()
  resetSettingsCache()
  const rules = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), loadAllPermissionRulesFromDisk())

  section('the rules, where the files lie in the checkout')
  check('the Read gate refuses each of the five files the rules name', REFUSED.every(rel => refused(rules, join(fixture, rel))), REFUSED.filter(rel => !refused(rules, join(fixture, rel))).join(', '))
  check('…and none of the four they do not', Object.keys(OPEN).every(rel => !refused(rules, join(fixture, rel))))

  section('a crewmate\'s isolated copy, on an account that may not make a link')
  const crewmate = await make('agent-ac100001', { permission: rules })
  await crewmate.ready
  check('the link was asked for and refused', refusals >= 2, String(refusals))
  await roadHolds('a crewmate\'s copy', crewmate.worktreePath, rules)

  section('a worktree a session enters (EnterWorktree, and --worktree at the start)')
  const session = await worktree.createWorktreeForSession(state.getSessionId(), 'copy-session', undefined, { gitRoot: fixture, permission: rules } as never)
  worktree.restoreWorktreeSession(null)
  await roadHolds('a session\'s worktree', session.worktreePath, rules)
  const enterTool = readFileSync(join(ROOT, 'src/tools/EnterWorktreeTool/EnterWorktreeTool.ts'), 'utf8')
  const setupSource = readFileSync(join(ROOT, 'src/setup.ts'), 'utf8')
  const mainSource = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
  check('EnterWorktree hands the session\'s rules to the worktree it makes', enterTool.includes('permission: context.getAppState().toolPermissionContext })'))
  check('the --worktree start hands the rules the command line gave: main to setup, setup to the same function', mainSource.includes('    worktreePRNumber,\n    undefined,\n    toolPermissionContext,\n  )') && setupSource.includes('createWorktreeForSession('))

  section('where the rules cannot be read')
  const blind = join(fixture, '.mercury', 'worktrees', 'blind')
  git(fixture, 'worktree', 'add', '-q', '-b', 'blind', blind, 'HEAD')
  await prepare(fixture, blind, fixture, true, 'unknown', false)
  check('nothing is copied: the folder is left out whole, never copied whole', kindOf(join(blind, 'node_modules')) === 'absent' && kindOf(join(blind, 'vendor', 'pack-open')) === 'absent', `${kindOf(join(blind, 'node_modules'))}, ${kindOf(join(blind, 'vendor', 'pack-open'))}`)

  section('the checkout')
  check('every file is where it was, the refused ones too', REFUSED.every(rel => kindOf(join(fixture, rel)) === 'file') && [...INSTRUCTIONS, ...OWN].every(rel => kindOf(join(fixture, rel)) === 'file') && Object.entries(OPEN).every(([rel, body]) => read(join(fixture, rel)) === body))
  writeFileSync(join(crewmate.worktreePath, 'node_modules', 'open', 'index.js'), 'changed in the copy\n')
  check('a write in the copy does not reach it', read(join(fixture, 'node_modules', 'open', 'index.js')) === OPEN['node_modules/open/index.js'])
} finally {
  Object.defineProperty(process, 'platform', platform)
  process.chdir(ROOT)
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
