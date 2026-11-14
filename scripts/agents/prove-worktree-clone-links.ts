#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneRoadExpected, volumeClones } from '../lib/cloneRoad.ts'

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

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { createAgentWorktree, unlockAgentWorktree } = await import('../../src/utils/worktree.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-clone-links-')))
const cloneRoad = cloneRoadExpected(scratch)
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '<absent>'
  }
}
const link = (path: string): string => {
  try {
    return readlinkSync(path)
  } catch {
    return '<no link>'
  }
}
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return '<dangling>'
  }
}
const resolved = (cwd: string, name: string): string => {
  try {
    return execFileSync('node', ['-e', `process.stdout.write(String(require(${JSON.stringify(name)})))`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    return `failed: ${String((error as { stderr?: string }).stderr ?? error).slice(0, 120)}`
  }
}

const sibling = join(scratch, 'sibling-project', 'pkg')
mkdirSync(sibling, { recursive: true })
writeFileSync(join(sibling, 'index.js'), 'module.exports = "the sibling project"\n')
const mono = join(scratch, 'mono')
mkdirSync(mono)
git(mono, 'init', '-q', '-b', 'main')
for (const [name, body] of Object.entries({
  '.gitignore': 'node_modules/\n',
  'package.json': '{"name":"links-fixture"}',
  'packages/lib/index.js': 'module.exports = "lib at the commit"\n',
  'packages/lib/package.json': '{"name":"@scope/lib","main":"index.js"}',
  'tools/abs-tool.js': 'module.exports = "tool at the commit"\n',
})) {
  mkdirSync(dirname(join(mono, name)), { recursive: true })
  writeFileSync(join(mono, name), body)
}
git(mono, 'add', '-A')
git(mono, 'commit', '-q', '-m', 'first')
const modules = join(mono, 'node_modules')
mkdirSync(join(modules, '@scope'), { recursive: true })
mkdirSync(join(modules, '.bin'))
mkdirSync(join(modules, 'pkg-0'))
mkdirSync(join(modules, 'sealed'))
writeFileSync(join(modules, 'pkg-0', 'index.js'), 'module.exports = "dependency"\n')
writeFileSync(join(modules, 'sealed', 'inside.js'), 'module.exports = "sealed"\n')
symlinkSync('../../packages/lib', join(modules, '@scope', 'lib'))
symlinkSync(join(mono, 'tools'), join(modules, 'abs-into-checkout'))
symlinkSync(join(mono, 'node_modules', 'pkg-0', 'index.js'), join(modules, '.bin', 'abs-into-folder'))
symlinkSync('../../sibling-project/pkg', join(modules, 'rel-out'))
symlinkSync(sibling, join(modules, 'abs-out'))
symlinkSync('./nowhere', join(modules, 'dangling'))
symlinkSync('../pkg-0/index.js', join(modules, '.bin', 'rel-inside'))
chmodSync(join(modules, 'sealed'), 0o555)

process.chdir(mono)
state.setOriginalCwd(mono)
state.setCwdState(mono)
state.setIsInteractive(true)
config.enableConfigs()

const rows = async (word: string, slug: string, expectCopy: boolean): Promise<void> => {
  const made = await createAgentWorktree(slug)
  const copy = made.worktreePath
  const inCopy = join(copy, 'node_modules')
  if (!expectCopy) {
    skip(`${word}: no clone here, the folder is a link to the checkout's and its links are the checkout's own`)
    check(`${word}: node_modules is a link to the checkout's`, lstatSync(inCopy).isSymbolicLink() && real(inCopy) === real(modules))
    writeFileSync(join(copy, 'packages', 'lib', 'index.js'), 'module.exports = "lib as the crewmate edited it"\n')
    check(`${word}: a crewmate's build resolves the workspace package to the CHECKOUT's sources, not its own edit (what the link costs)`, resolved(copy, '@scope/lib') === 'lib at the commit', resolved(copy, '@scope/lib'))
    return
  }
  check(`${word}: node_modules is a directory of the copy`, lstatSync(inCopy).isDirectory() && !lstatSync(inCopy).isSymbolicLink())
  check(`${word}: a relative link that stays inside the checkout is kept as written and resolves inside the copy`, link(join(inCopy, '@scope', 'lib')) === '../../packages/lib' && real(join(inCopy, '@scope', 'lib')) === real(join(copy, 'packages', 'lib')), `${link(join(inCopy, '@scope', 'lib'))} · ${real(join(inCopy, '@scope', 'lib'))}`)
  writeFileSync(join(copy, 'packages', 'lib', 'index.js'), 'module.exports = "lib as the crewmate edited it"\n')
  check(`${word}: a crewmate's build resolves the workspace package to its OWN edited sources`, resolved(copy, '@scope/lib') === 'lib as the crewmate edited it', resolved(copy, '@scope/lib'))
  check(`${word}: …and the checkout's build still resolves the checkout's`, resolved(mono, '@scope/lib') === 'lib at the commit', resolved(mono, '@scope/lib'))
  check(`${word}: an absolute link into the checkout names the same place in the copy`, link(join(inCopy, 'abs-into-checkout')) === join(copy, 'tools'), link(join(inCopy, 'abs-into-checkout')))
  check(`${word}: an absolute link into the cloned folder names the copy's own file`, link(join(inCopy, '.bin', 'abs-into-folder')) === join(copy, 'node_modules', 'pkg-0', 'index.js'), link(join(inCopy, '.bin', 'abs-into-folder')))
  writeFileSync(join(inCopy, '.bin', 'abs-into-folder'), 'module.exports = "written through the link in the copy"\n')
  check(`${word}: a write through that link lands in the copy and never in the checkout`, read(join(inCopy, 'pkg-0', 'index.js')) === 'module.exports = "written through the link in the copy"\n' && read(join(modules, 'pkg-0', 'index.js')) === 'module.exports = "dependency"\n', read(join(modules, 'pkg-0', 'index.js')))
  check(`${word}: a relative link out of the checkout still reaches the place it named`, real(join(inCopy, 'rel-out')) === real(sibling) && resolved(copy, 'rel-out') === 'the sibling project', `${link(join(inCopy, 'rel-out'))} · ${real(join(inCopy, 'rel-out'))}`)
  check(`${word}: an absolute link out of the checkout is kept as written`, link(join(inCopy, 'abs-out')) === sibling)
  check(`${word}: a relative link inside the folder and a link to nothing are kept as written`, link(join(inCopy, '.bin', 'rel-inside')) === '../pkg-0/index.js' && link(join(inCopy, 'dangling')) === './nowhere')
  check(`${word}: a folder the checkout holds read-only is the owner's to write in the copy, its file whole`, (statSync(join(inCopy, 'sealed')).mode & 0o200) !== 0 && read(join(inCopy, 'sealed', 'inside.js')) === 'module.exports = "sealed"\n', (statSync(join(inCopy, 'sealed')).mode & 0o7777).toString(8))
  check(`${word}: nothing of the checkout moved: its links, its read-only folder, its files`, link(join(modules, 'abs-into-checkout')) === join(mono, 'tools') && link(join(modules, '.bin', 'abs-into-folder')) === join(mono, 'node_modules', 'pkg-0', 'index.js') && link(join(modules, 'rel-out')) === '../../sibling-project/pkg' && (statSync(join(modules, 'sealed')).mode & 0o7777) === 0o555 && read(join(mono, 'packages', 'lib', 'index.js')) === 'module.exports = "lib at the commit"\n')
  await unlockAgentWorktree(copy, mono)
  git(copy, 'checkout', '-q', '--', 'packages/lib/index.js')
  let removal = ''
  try {
    git(mono, 'worktree', 'remove', copy)
  } catch (error) {
    removal = String((error as { stderr?: string }).stderr ?? error)
  }
  check(`${word}: an ordinary git worktree remove takes the copy, the once read-only folder with it`, removal === '' && !existsSync(copy), removal.slice(0, 200))
}

section("§1 the links inside a cloned folder, on the platform's own road (one call a folder on APFS, file by file on Linux)")
await rows("the platform's road", 'agent-ac100001', cloneRoad)

section("§2 the same links on the file-by-file road (Linux's reflinks), through MERCURY_WORKTREE_CLONE=files")
process.env.MERCURY_WORKTREE_CLONE = 'files'
await rows('file by file', 'agent-ac200001', volumeClones(scratch) && process.platform !== 'win32')
delete process.env.MERCURY_WORKTREE_CLONE

section('§3 with no clone the folder is the link it was, and its links are the checkout\'s own')
process.env.MERCURY_WORKTREE_CLONE = 'off'
await rows('no clone', 'agent-ac300001', false)
delete process.env.MERCURY_WORKTREE_CLONE

process.chdir(ROOT)
state.setOriginalCwd(ROOT)
state.setCwdState(ROOT)
if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
