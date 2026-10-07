#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const onWindows = process.platform === 'win32'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agent-cwd-posix-drive-')))
const work = join(scratch, 'work')
const inside = join(work, 'lane')
const outside = join(scratch, 'elsewhere')
const repo = join(scratch, 'repo')
const nested = join(repo, 'src')
const aFile = join(work, 'a-file')
const missing = join(work, 'nowhere')
for (const dir of [inside, outside, nested]) mkdirSync(dir, { recursive: true })
writeFileSync(aFile, 'x\n')
writeFileSync(join(nested, 'a.txt'), 'one\n')

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'add', '-A')
git(repo, 'commit', '-q', '-m', 'first')

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { AgentTool, agentCwdQuestion, resolveAgentCwd } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { createAgentWorktree, preflightWorktreeCapability, settleAgentWorktree } = await import('../../src/utils/worktree.ts')
const { getCwd } = await import('../../src/utils/cwd.ts')

process.chdir(work)
state.setOriginalCwd(work)
state.setCwdState(work)
state.setIsInteractive(true)
config.enableConfigs()
const context = getEmptyToolPermissionContext()
const sessionFolder = getCwd()

let failed = 0
let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Attempt = { value: string; message: string }
const attempt = (spelling: string): Attempt => {
  try {
    return { value: resolveAgentCwd(spelling, context), message: '' }
  } catch (error) {
    return { value: '', message: error instanceof Error ? error.message : String(error) }
  }
}
const sameFolder = (a: string, b: string): boolean => a !== '' && (onWindows ? a.toLowerCase() === b.toLowerCase() : a === b)
const mentions = (text: string, part: string): boolean => (onWindows ? text.toLowerCase().includes(part.toLowerCase()) : text.includes(part))
const posixSpelling = (path: string): string => `/${path[0]!.toLowerCase()}${path.slice(2).replaceAll('\\', '/')}`
const seatIn = (mode: string): never => ({ getAppState: () => ({ toolPermissionContext: { ...context, mode } }), abortController: new AbortController(), options: {} }) as never
const launchInput = (cwd: string): { description: string; prompt: string; cwd: string } => ({ description: 'probe', prompt: 'report directory', cwd })

try {
  section('the Windows directory guard runs with native filesystem answers on every host')
  const source = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  const declaration = source.slice(source.indexOf('function agentDirectoryOf('), source.indexOf('export function resolveAgentCwd('))
  check('the actual product declaration was found', declaration.startsWith('function agentDirectoryOf(') && declaration.includes('statSync('))
  const { posixPathToWindowsPath } = await import('../../src/utils/windowsPaths.ts')
  const nativeFolder = 'C:\\proof\\lane'
  const seen: string[] = []
  const lookup = (path: string) => {
    seen.push(path)
    if (win32.normalize(path).toLowerCase() !== nativeFolder.toLowerCase()) throw new Error('missing')
    return { isDirectory: () => true }
  }
  const guard = new Function('isAbsolute', 'statSync', 'realpathSync', 'getCwd', 'getPlatform', 'posixPathToWindowsPath', new Bun.Transpiler({ loader: 'ts' }).transformSync(declaration) + '\nreturn agentDirectoryOf;')(win32.isAbsolute, lookup, (path: string) => { lookup(path); return nativeFolder }, () => 'C:\\proof', () => 'windows', posixPathToWindowsPath) as (path: string) => string
  for (const path of ['/c/proof/lane', '/C/proof/lane', nativeFolder, 'C:/proof/lane']) {
    seen.length = 0
    let result = ''
    try { result = guard(path) } catch (error) { result = String(error) }
    check(`Windows guard maps ${path} before stat and realpath`, result === nativeFolder && seen.every(value => /^[a-z]:[/\\]/i.test(value)), result)
  }
  if (!onWindows) console.log('[SKIP] live Windows filesystem, permission and worktree legs require Windows; the product guard above ran here')
  if (onWindows) {
    section('a Git Bash drive spelling (/c/...) names the folder it spells')
    const insideAt = attempt(posixSpelling(inside))
    check('a /c/ spelling of a folder under the session folder resolves to its real path', sameFolder(insideAt.value, realpathSync(inside)), insideAt.message)
    const sessionAt = attempt(posixSpelling(work))
    check('the session folder itself, spelled /c/..., resolves to the session folder', sameFolder(sessionAt.value, realpathSync(work)), sessionAt.message)
    const upperAt = attempt(`/${inside[0]!.toUpperCase()}${posixSpelling(inside).slice(2)}`)
    check('an upper-case drive letter in the /c/ spelling names the same folder', sameFolder(upperAt.value, realpathSync(inside)), upperAt.message)
    const nativeAt = attempt(inside)
    check('the /c/ spelling resolves to exactly what the C:\\ spelling resolves to', insideAt.value !== '' && sameFolder(insideAt.value, nativeAt.value), `${insideAt.value || insideAt.message} vs ${nativeAt.value || nativeAt.message}`)
    const outsideAt = attempt(posixSpelling(outside))
    check('a folder outside the session folder resolves too: consent stays with the ordinary permission check', sameFolder(outsideAt.value, realpathSync(outside)), outsideAt.message)

    section('the permission ask and the launch read the mapped folder')
    const question = agentCwdQuestion(posixSpelling(outside), context)
    check('the ask for a folder outside the session folder names the real folder, not the /c/ spelling', question?.behavior === 'ask' && mentions(question.message, realpathSync(outside)) && !question.message.includes(posixSpelling(outside)), question === null ? 'no question was raised' : question.message)
    check('a /c/ launch inside the session folder needs no folder permission', insideAt.value !== '' && agentCwdQuestion(posixSpelling(inside), context) === null, insideAt.message)
    const asked = await AgentTool.checkPermissions(launchInput(posixSpelling(outside)), seatIn('default'))
    check('default: the tool asks before a /c/ launch outside the session folder', asked.behavior === 'ask', asked.behavior)
    const sovereign = await AgentTool.checkPermissions(launchInput(posixSpelling(outside)), seatIn('sovereign'))
    check('sovereign: the same launch proceeds without an ask', outsideAt.value !== '' && sovereign.behavior === 'allow', outsideAt.message || sovereign.behavior)
    const nestedAt = attempt(posixSpelling(nested))
    const capability = nestedAt.value === '' ? null : preflightWorktreeCapability(nestedAt.value)
    check("the worktree preflight reads the repository of the folder the /c/ spelling names", capability !== null && capability.available && mentions(capability.detail, repo), capability === null ? nestedAt.message : capability.detail)
    let cut: Awaited<ReturnType<typeof createAgentWorktree>> | null = null
    let cutError = nestedAt.message
    if (nestedAt.value !== '') {
      try {
        cut = await createAgentWorktree('agent-posix001', { from: nestedAt.value })
      } catch (error) {
        cutError = error instanceof Error ? error.message : String(error)
      }
    }
    check("the worktree is cut from that folder's repository, not the session's", cut !== null && sameFolder(cut.gitRoot ?? '', repo) && existsSync(join(cut.worktreePath, 'src', 'a.txt')), cut === null ? cutError : `${cut.gitRoot} · ${cut.worktreePath}`)
    if (cut !== null) await settleAgentWorktree({ ...cut })

    section('the native spellings behave as they did')
    const driveLower = `${inside[0]!.toLowerCase()}${inside.slice(1)}`
    for (const [label, spelling] of [['a C:\\ spelling', inside], ['a C:/ spelling', inside.replaceAll('\\', '/')], ['a lower-case drive letter', driveLower]] as const) {
      const at = attempt(spelling)
      check(`${label} resolves to the folder's real path`, sameFolder(at.value, realpathSync(inside)), at.message)
    }
  }

  section('the refusals keep their words')
  const spellings = (path: string): string[] => (onWindows ? [path, posixSpelling(path)] : [path])
  for (const spelling of spellings(missing)) {
    check(`a missing folder, written ${JSON.stringify(spelling)}, is refused naming the spelling and the session folder`, attempt(spelling).message === `cwd does not exist: ${spelling} (the session folder is ${sessionFolder})`, attempt(spelling).message || 'resolved')
  }
  for (const spelling of spellings(aFile)) {
    check(`a file, written ${JSON.stringify(spelling)}, is refused as not a folder`, attempt(spelling).message === `cwd is not a folder: ${spelling}`, attempt(spelling).message || 'resolved')
  }
  for (const spelling of ['lane', '', '~/lane', './lane', `c/${basename(scratch)}`, ` ${inside}`]) {
    check(`a relative spelling ${JSON.stringify(spelling)} is refused as such`, attempt(spelling).message === `cwd must be an absolute directory: ${spelling} (the session folder is ${sessionFolder})`, attempt(spelling).message || `resolved to ${attempt(spelling).value}`)
  }
  for (const spelling of spellings(inside).map(path => `${path}${String.fromCharCode(0)}`)) {
    check(`an impossible spelling ${JSON.stringify(spelling)} is still refused as a missing folder`, attempt(spelling).message === `cwd does not exist: ${spelling} (the session folder is ${sessionFolder})`, attempt(spelling).message || 'resolved')
  }
  if (!onWindows) {
    const posixDrive = `/c/${basename(scratch)}/lane`
    check('a /c/ spelling is an ordinary path here, not a drive: refused as missing', attempt(posixDrive).message === `cwd does not exist: ${posixDrive} (the session folder is ${sessionFolder})`, attempt(posixDrive).message || 'resolved')
    check('an existing folder resolves to its real path', attempt(inside).value === realpathSync(inside), attempt(inside).message)
  }
} finally {
  process.chdir(ROOT)
  state.setOriginalCwd(ROOT)
  state.setCwdState(ROOT)
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    console.log(`scratch kept: ${scratch}`)
  }
}
console.log(`agent-cwd-posix-drive: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
