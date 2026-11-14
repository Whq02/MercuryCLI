#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { volumeClones } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_WORKTREE_CLONE
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { applyPermissionRulesToPermissionContext } = await import('../../src/utils/permissions/permissions.ts')
const { loadAllPermissionRulesFromDisk } = await import('../../src/utils/permissions/permissionsLoader.ts')
const { checkReadPermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')
const worktree = await import('../../src/utils/worktree.ts')
const { discardSetAside, setWorktreeAside } = await import('../../src/utils/worktreeClone.ts')
type Made = { worktreePath: string; worktreeBranch?: string; gitRoot?: string; prepareFailure?: string; ready?: Promise<void> }
const make = (slug: string, options: Record<string, unknown> = {}): Promise<Made> => (worktree.createAgentWorktree as (slug: string, options: unknown) => Promise<Made>)(slug, options)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-clone-held-')))
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
const enter = (dir: string): void => {
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
  resetSettingsCache()
}
const linkTo = (path: string, target: string): boolean => kindOf(path) === 'link' && realpathSync(path) === realpathSync(target)
const reader = { name: 'Read', getPath: (input: { file_path: string }): string => input.file_path }
const refused = (context: unknown, path: string): boolean => (checkReadPermissionForTool as (tool: unknown, input: unknown, context: unknown) => { behavior: string })(reader, { file_path: path }, context).behavior === 'deny'
const HELD = ['node_modules/private/key.txt', 'node_modules/private/deep/more.txt', 'node_modules/mixed/secret.pem', 'node_modules/mixed/inner/also.pem', 'vendor/pack-secret/marker']
const OPEN = ['node_modules/open/index.js', 'node_modules/mixed/ok.js', 'node_modules/mixed/inner/fine.js', 'vendor/pack-open/marker']

const makeFixture = (name: string, rules: (dir: string) => string[]): string => {
  const dir = join(scratch, name)
  mkdirSync(join(dir, 'vendor'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\nvendor/*/\n.mercury/\n')
  writeFileSync(join(dir, 'package.json'), `{"name":"${name}"}\n`)
  writeFileSync(join(dir, 'vendor', 'pack-open.lock.json'), '{}\n')
  writeFileSync(join(dir, 'vendor', 'pack-secret.lock.json'), '{}\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  for (const [file, body] of Object.entries({
    'node_modules/open/index.js': 'module.exports = "open"\n',
    'node_modules/private/key.txt': 'the key\n',
    'node_modules/private/deep/more.txt': 'more of it\n',
    'node_modules/mixed/ok.js': 'module.exports = "ok"\n',
    'node_modules/mixed/secret.pem': 'a certificate\n',
    'node_modules/mixed/inner/also.pem': 'another\n',
    'node_modules/mixed/inner/fine.js': 'module.exports = "fine"\n',
    'vendor/pack-open/marker': 'open pack\n',
    'vendor/pack-secret/marker': 'secret pack\n',
  })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), body)
  }
  mkdirSync(join(dir, 'node_modules', '.bin'))
  symlinkSync('../open/index.js', join(dir, 'node_modules', '.bin', 'tool'))
  mkdirSync(join(dir, '.mercury'), { recursive: true })
  writeFileSync(join(dir, '.mercury', 'settings.json'), JSON.stringify({ guardrails: { deny: rules(dir) } }))
  return dir
}
const absolutely = (dir: string, rel: string): string => `Read(/${dir}/${rel})`

try {
  state.setIsInteractive(true)
  config.enableConfigs()
  const cloning = volumeClones(scratch) && process.platform !== 'win32'
  const fixture = makeFixture('held', dir => [absolutely(dir, 'node_modules/private/**'), absolutely(dir, 'vendor/pack-secret/**'), 'Read(**/*.pem)'])
  enter(fixture)
  const rules = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), loadAllPermissionRulesFromDisk())

  section('§0 the rules, where the files lie in the checkout')
  check('the Read gate refuses each of the five files the rules name', HELD.every(rel => refused(rules, join(fixture, rel))), HELD.filter(rel => !refused(rules, join(fixture, rel))).join(', '))
  check('…and none of the four they do not', OPEN.every(rel => !refused(rules, join(fixture, rel))), OPEN.filter(rel => refused(rules, join(fixture, rel))).join(', '))

  if (!cloning) {
    section('a volume that cannot clone: the folders are links to the checkout\'s, and the rules answer through them as before')
    skip("the proof's runtime cannot force a clone of one file here: nothing is cloned, so nothing is held back from a clone")
    const linked = await make('agent-ac000001')
    check('the copy\'s folders are the links', linkTo(join(linked.worktreePath, 'node_modules'), join(fixture, 'node_modules')))
    check('the Read gate refuses the five files through the copy', HELD.every(rel => refused(rules, join(linked.worktreePath, rel))))
  } else {
    const roads: Array<[string, string | undefined]> = [['the platform\'s road', undefined], ['the file-by-file road', 'files']]
    let slug = 0
    for (const [road, seam] of roads) {
      section(`§ ${road}: what a Read deny rule matches where it lies in the checkout is not cloned`)
      if (seam === undefined) delete process.env.MERCURY_WORKTREE_CLONE
      else process.env.MERCURY_WORKTREE_CLONE = seam
      const made = await make(`agent-ac10000${++slug}`)
      const copy = made.worktreePath
      check('the dependency folder is the copy\'s own', kindOf(join(copy, 'node_modules')) === 'folder', kindOf(join(copy, 'node_modules')))
      check('a file no rule names is the copy\'s own: a write there does not reach the checkout', (() => {
        if (kindOf(join(copy, 'node_modules', 'open', 'index.js')) !== 'file') return false
        writeFileSync(join(copy, 'node_modules', 'open', 'index.js'), 'changed in the copy\n')
        return read(join(fixture, 'node_modules', 'open', 'index.js')) === 'module.exports = "open"\n'
      })())
      check('the folder a rule names whole stands in the copy as a link to the checkout\'s', linkTo(join(copy, 'node_modules', 'private'), join(fixture, 'node_modules', 'private')), `${kindOf(join(copy, 'node_modules', 'private'))}`)
      check('a file a rule names stands as a link to the checkout\'s file, the folder around it the copy\'s own', kindOf(join(copy, 'node_modules', 'mixed')) === 'folder' && linkTo(join(copy, 'node_modules', 'mixed', 'secret.pem'), join(fixture, 'node_modules', 'mixed', 'secret.pem')) && kindOf(join(copy, 'node_modules', 'mixed', 'ok.js')) === 'file', `${kindOf(join(copy, 'node_modules', 'mixed'))}, ${kindOf(join(copy, 'node_modules', 'mixed', 'secret.pem'))}, ${kindOf(join(copy, 'node_modules', 'mixed', 'ok.js'))}`)
      check('…at any depth', kindOf(join(copy, 'node_modules', 'mixed', 'inner')) === 'folder' && linkTo(join(copy, 'node_modules', 'mixed', 'inner', 'also.pem'), join(fixture, 'node_modules', 'mixed', 'inner', 'also.pem')) && kindOf(join(copy, 'node_modules', 'mixed', 'inner', 'fine.js')) === 'file')
      check('a link that was in the folder is still the link it was', kindOf(join(copy, 'node_modules', '.bin', 'tool')) === 'link' && readlinkSync(join(copy, 'node_modules', '.bin', 'tool')) === '../open/index.js')
      check('a pack a rule names whole is the link to the checkout\'s, as before; the pack beside it is the copy\'s own', linkTo(join(copy, 'vendor', 'pack-secret'), join(fixture, 'vendor', 'pack-secret')) && kindOf(join(copy, 'vendor', 'pack-open')) === 'folder', `${kindOf(join(copy, 'vendor', 'pack-secret'))}, ${kindOf(join(copy, 'vendor', 'pack-open'))}`)
      check('the Read gate refuses each of the five files through the copy, as it does in the checkout', HELD.every(rel => refused(rules, join(copy, rel))), HELD.filter(rel => !refused(rules, join(copy, rel))).join(', '))
      check('…and none of the four no rule names', OPEN.every(rel => !refused(rules, join(copy, rel))), OPEN.filter(rel => refused(rules, join(copy, rel))).join(', '))
      check('git sees nothing to commit in the copy', git(copy, 'status', '--porcelain') === '', git(copy, 'status', '--porcelain').slice(0, 200))
      check('no failure is reported and nothing is left beside the copy', made.prepareFailure === undefined && readdirSync(dirname(copy)).every(name => !name.startsWith('.cloning-')))
      const aside = setWorktreeAside(copy)
      if (aside !== null) discardSetAside(aside)
      const end = Date.now() + 15_000
      while (readdirSync(dirname(copy)).some(name => name.startsWith('.removing-')) && Date.now() < end) await wait(50)
      git(fixture, 'worktree', 'prune')
      check('the delete of a copy set aside takes the links and never what they name', aside !== null && !existsSync(copy) && !existsSync(aside) && HELD.every(rel => read(join(fixture, rel)) !== '<absent>') && read(join(fixture, 'node_modules', 'private', 'key.txt')) === 'the key\n' && read(join(fixture, 'vendor', 'pack-secret', 'marker')) === 'secret pack\n', `set aside ${String(aside)}, still there ${existsSync(copy)}`)
    }
    delete process.env.MERCURY_WORKTREE_CLONE

    section('§ the Crewmate road reads the rules of the running session')
    const sessionRule = { source: 'session', ruleBehavior: 'deny', ruleValue: { toolName: 'Read', ruleContent: `/${fixture}/node_modules/open/**` } }
    const live = applyPermissionRulesToPermissionContext(rules, [sessionRule as never])
    const launched = await make('agent-ac200001', { foldersBehindLaunch: true, permission: live })
    await launched.ready
    check('a rule that exists only in the session holds its folder back too', linkTo(join(launched.worktreePath, 'node_modules', 'open'), join(fixture, 'node_modules', 'open')) && linkTo(join(launched.worktreePath, 'node_modules', 'private'), join(fixture, 'node_modules', 'private')) && kindOf(join(launched.worktreePath, 'node_modules')) === 'folder', `${kindOf(join(launched.worktreePath, 'node_modules', 'open'))}`)
    check('…and the gate refuses it through the copy', refused(live, join(launched.worktreePath, 'node_modules', 'open', 'index.js')))
    const agentTool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
    check('the Crewmate tool hands the session\'s rules to the copy it asks for', agentTool.includes('foldersBehindLaunch: true,\n        permission: context.getAppState().toolPermissionContext,'))

    section('§ a project with no Read rule: nothing is held back')
    const plain = makeFixture('plain', () => [])
    enter(plain)
    const whole = await make('agent-ac300001')
    check('every folder and file is the copy\'s own', [...HELD, ...OPEN].every(rel => kindOf(join(whole.worktreePath, rel)) === 'file') && kindOf(join(whole.worktreePath, 'vendor', 'pack-secret')) === 'folder', [...HELD, ...OPEN].filter(rel => kindOf(join(whole.worktreePath, rel)) !== 'file').join(', '))
  }
} finally {
  delete process.env.MERCURY_WORKTREE_CLONE
  enter(ROOT)
  await wait(200)
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
