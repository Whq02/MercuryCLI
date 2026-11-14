#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-glob-')))
const project = join(launch, 'project')
const STORE = join(launch, 'mercury-home')
const TWINS = join(launch, 'twins')
const PRIVATE = join(launch, 'private-tmp')
for (const dir of [project, STORE, TWINS]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_TMPDIR = PRIVATE
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

const PORT = 27067
const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 540 seconds')
  process.exit(1)
}, 540_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Rules = { allow?: string[]; deny?: string[]; mode?: string }
type Input = { pattern: string; path?: string }
type Decision = { behavior: string; message?: string; suggestions?: Array<{ rules?: Array<{ toolName: string; ruleContent: string }> }> }
const rulesOf = (rules: Rules = {}) =>
  ({
    ...getEmptyToolPermissionContext(),
    mode: rules.mode ?? 'sovereign',
    alwaysAllowRules: rules.allow ? { userSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {},
  }) as never
const contextOf = (rules: Rules = {}) =>
  ({
    messages: [],
    options: { engineModel: 'claude-opus-4-8', tools: [] },
    readFileState: createFileStateCacheWithSizeLimit(100),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: rulesOf(rules) }),
  }) as never
const thrown = (error: unknown): string => `THROWN ${error instanceof Error ? error.message : String(error)}`
const glob = async (input: Input, rules: Rules = {}): Promise<string> => {
  try {
    const context = contextOf(rules)
    const verdict = (await GlobTool.validateInput!(input as never, context)) as { result: boolean; message?: string }
    if (verdict.result === false) return `THROWN ${verdict.message}`
    const result = await GlobTool.call(input as never, context, undefined as never, { message: { id: 'remote-glob' } } as never)
    return String(GlobTool.mapToolResultToToolResultBlockParam(result.data as never, 'proof').content)
  } catch (error) {
    return thrown(error)
  }
}
const validated = async (input: Input, rules: Rules = {}): Promise<{ result: boolean; message?: string }> => {
  try {
    return (await GlobTool.validateInput!(input as never, contextOf(rules))) as { result: boolean; message?: string }
  } catch (error) {
    return { result: false, message: thrown(error) }
  }
}
const decided = async (input: Input, rules: Rules = {}): Promise<Decision> => {
  try {
    return (await GlobTool.checkPermissions(input as never, contextOf(rules))) as unknown as Decision
  } catch (error) {
    return { behavior: 'thrown', message: thrown(error) }
  }
}
const remote = (path: string): string => `ssh://box${path}`
const namesIn = (path: string): string[] => (existsSync(path) && statSync(path).isDirectory() ? readdirSync(path, { recursive: true }).map(String) : [])
const leftBehind = (): string[] => namesIn(PRIVATE).filter(name => name.includes('copy-'))

const TREE: Array<[string, string | Buffer]> = [
  ['README.md', '# proj\n'],
  ['.gitignore', 'dist/\n*.log\nnode_modules/\n'],
  ['src/a.ts', 'export const a = 1\n'],
  ['src/b.ts', 'export const b = 2\n'],
  ['src/deep/c.ts', 'export const c = 3\n'],
  ['src/deep/deeper/d.test.ts', 'test()\n'],
  ['src/my file.ts', 'spaced\n'],
  ['src/it\'s "quoted" $(touch RAN).ts', 'quoted\n'],
  ['src/ünï.ts', 'accents\n'],
  ['docs/guide.md', 'guide\n'],
  ['docs/more/deep.md', 'deep\n'],
  ['dist/out.js', 'built\n'],
  ['app.log', 'log\n'],
  ['.env', 'SECRET=1\n'],
  ['.hidden/kept.ts', 'hidden\n'],
  ['node_modules/x/index.js', 'module\n'],
  ['.git/config', '[core]\n'],
  ['.git/info/exclude', 'excluded-by-info.ts\n'],
  ['excluded-by-info.ts', 'excluded\n'],
  ['sub/.ignore', 'skipped.ts\n'],
  ['sub/skipped.ts', 'skipped\n'],
  ['sub/kept.ts', 'kept\n'],
  ['bin/tool', Buffer.alloc(5 * 1024 * 1024, 7)],
]
function plant(root: string): void {
  TREE.forEach(([name, bytes], index) => {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), bytes)
    const at = new Date(1_700_000_000_000 + index * 60_000)
    utimesSync(join(root, name), at, at)
  })
  symlinkSync('a.ts', join(root, 'src', 'link.ts'))
  symlinkSync('docs', join(root, 'docs-link'))
}

async function searches(world: RemoteWorld): Promise<void> {
  const name = world.transport
  const far = join(world.data, 'proj')
  const near = join(TWINS, name, 'proj')
  plant(far)
  plant(near)
  const there = remote(far)

  section(`${name} · what Glob lists on another machine is what it lists for the same tree here`)
  const patterns = ['**/*.ts', '*.md', '**/*.md', 'docs', 'docs/*', 'src/*', 'src/**', '**/c.ts', '**/*.{ts,md}', '**/*.js', '**/*.test.ts', '*', '**', 'sub/**', '.hidden/**', 'nothing-like-it/**', '**/*.TS', 'src/[ab].ts', 'src/deep/*.ts', 'src/nope/*.ts', 'src/a.ts']
  for (const pattern of patterns) {
    const answer = await glob({ pattern, path: there })
    const here = (await glob({ pattern, path: near })).replaceAll(near, there)
    check(`${name}: ${pattern}`, answer === here && !answer.startsWith('THROWN'), `remote ${JSON.stringify(answer.slice(0, 400))} local ${JSON.stringify(here.slice(0, 400))}`)
  }
  const inPattern = await glob({ pattern: `${there}/src/**/*.ts` })
  const inPatternHere = (await glob({ pattern: `${near}/src/**/*.ts` })).replaceAll(near, there)
  check(`${name}: the root written inside the pattern`, inPattern === inPatternHere && inPattern.includes(`${there}/src/deep/c.ts`), `${inPattern.slice(0, 300)} | ${inPatternHere.slice(0, 300)}`)
  check(`${name}: a name with a quote and a command substitution is listed, and ran nothing`, (await glob({ pattern: '**/*quoted*', path: there })).includes('$(touch RAN).ts') && !existsSync(join(far, 'RAN')) && !existsSync(join(world.remoteHome, 'RAN')))
  const crowd = join(far, 'crowd')
  const crowdHere = join(near, 'crowd')
  for (const root of [crowd, crowdHere]) {
    for (let index = 0; index < 130; index++) {
      mkdirSync(join(root, `g${index % 4}`), { recursive: true })
      writeFileSync(join(root, `g${index % 4}`, `f-${String(index).padStart(3, '0')}.txt`), '')
      const at = new Date(1_700_100_000_000 + index * 60_000)
      utimesSync(join(root, `g${index % 4}`, `f-${String(index).padStart(3, '0')}.txt`), at, at)
    }
  }
  const sampled = await glob({ pattern: '**/*.txt', path: remote(crowd) })
  const sampledHere = (await glob({ pattern: '**/*.txt', path: crowdHere })).replaceAll(crowdHere, remote(crowd))
  check(`${name}: more files than one answer holds: the same sample across the top folders, newest first, and the same sentence`, sampled === sampledHere && sampled.includes('Results are truncated') && sampled.split('\n').length === 101, `${sampled.split('\n').length} lines: ${sampled.slice(-200)} | ${sampledHere.slice(-200)}`)

  section(`${name} · the root as it was written`)
  mkdirSync(join(world.remoteHome, 'homed', 'src'), { recursive: true })
  writeFileSync(join(world.remoteHome, 'homed', 'src', 'h.ts'), '')
  const homed = await glob({ pattern: '**/*.ts', path: 'ssh://box/~/homed' })
  check(`${name}: a root under the account's home answers under ~`, homed === 'ssh://box/~/homed/src/h.ts', homed)
  symlinkSync(far, join(world.data, 'linked'))
  const linked = await glob({ pattern: 'docs/*.md', path: remote(join(world.data, 'linked')) })
  check(`${name}: a root that is a link is searched, and answers under the link as written`, linked === `${remote(join(world.data, 'linked'))}/docs/guide.md`, linked)
  const throughLink = await glob({ pattern: 'docs-link/**/*.md', path: there })
  check(`${name}: a pattern that goes through a folder that is a link lists what is behind it, under the link as written`, throughLink.split('\n').sort().join('\n') === [`${there}/docs-link/guide.md`, `${there}/docs-link/more/deep.md`].join('\n'), throughLink)
  check(`${name}: with or without a closing slash`, (await glob({ pattern: 'docs/*.md', path: `${there}/` })) === `${there}/docs/guide.md`, await glob({ pattern: 'docs/*.md', path: `${there}/` }))

  section(`${name} · what a search of another machine answers in words of its own`)
  check(`${name}: a folder that is not there`, (await glob({ pattern: '*', path: `${there}/nope` })) === 'THROWN There is no folder at that path on box.', await glob({ pattern: '*', path: `${there}/nope` }))
  mkdirSync(join(project, 'ssh:', 'box', far.slice(1), 'nope'), { recursive: true })
  writeFileSync(join(project, 'ssh:', 'box', far.slice(1), 'nope', 'local.ts'), 'a file on this disk\n')
  const collapsed = await glob({ pattern: `${there}/nope/**/*.ts` })
  check(`${name}: the root written inside the pattern never searches this disk at the spelling the two slashes collapse to`, collapsed === 'THROWN There is no folder at that path on box.', collapsed)
  rmSync(join(project, 'ssh:'), { recursive: true, force: true })
  check(`${name}: a file given as the folder`, (await glob({ pattern: '*', path: `${there}/README.md` })) === `THROWN Path is not a directory: ${there}/README.md`, await glob({ pattern: '*', path: `${there}/README.md` }))
  check(`${name}: ssh:// alone`, (await glob({ pattern: '*', path: 'ssh://' })) === 'THROWN ssh:// alone is the list of hosts, which Read shows; a search needs a host: ssh://<host>/<folder>.', await glob({ pattern: '*', path: 'ssh://' }))

  section(`${name} · the rules`)
  closeRemoteConnections()
  const connected = world.connectLines().length
  const asked = await decided({ pattern: '**/*.ts', path: there }, { mode: 'default' })
  const shaped = await validated({ pattern: '**/*.ts', path: there }, { mode: 'default' })
  check(`${name}: with no rule the default mode asks and offers reading from the host for the session; neither the question nor the check of the input makes a connection`, asked.behavior === 'ask' && JSON.stringify(asked.suggestions?.[0]?.rules) === JSON.stringify([{ toolName: 'Read', ruleContent: 'ssh://box/**' }]) && shaped.result === true && world.connectLines().length === connected, `${JSON.stringify(asked)} ${JSON.stringify(shaped)}`)
  check(`${name}: a rule that allows reading on the host allows the search`, (await decided({ pattern: '**/*.ts', path: there }, { mode: 'default', allow: ['Read(ssh://box/**)'] })).behavior === 'allow')
  const denyRoot = { mode: 'default', allow: ['Read(ssh://box/**)'], deny: [`Read(ssh://box${far}/docs/**)`] }
  const refused = await validated({ pattern: '*', path: `${there}/docs` }, denyRoot)
  check(`${name}: a deny rule on the folder refuses the search by its own path, before anything connects`, refused.result === false && refused.message === `Searching ${there}/docs is denied by the rule Read(ssh://box${far}/docs/**) in your user settings.`, String(refused.message))
  const filtered = await glob({ pattern: '**/*.md', path: there }, denyRoot)
  check(`${name}: files under a denied folder are not listed by a search from above it, by the folder's path or through a link to it`, filtered === `${there}/README.md`, filtered)
  const through = await glob({ pattern: '*', path: `${there}/docs-link` }, denyRoot)
  check(`${name}: and a search rooted at a link into the denied folder is refused once the remote machine has said where it leads`, through.startsWith('THROWN ') && through.includes('is denied by the rule'), through)
  mkdirSync(join(STORE, 'runtime', 'current'), { recursive: true })
  writeFileSync(join(STORE, '.credentials.json'), '{"secret":"never"}\n')
  writeFileSync(join(STORE, 'runtime', 'current', 'mercury.mjs'), 'the runtime\n')
  writeFileSync(join(launch, 'beside-the-store.txt'), 'beside\n')
  const above = await glob({ pattern: '**/*', path: remote(launch) }, { mode: 'default', allow: ['Read(ssh://box/**)'] })
  check(`${name}: on this machine a search from above Mercury's own store names nothing of its credentials`, above.includes(`${remote(launch)}/beside-the-store.txt`) && !above.includes('.credentials.json'), above.slice(0, 500))
  rmSync(join(STORE, 'runtime'), { recursive: true, force: true })
  rmSync(join(STORE, '.credentials.json'), { force: true })

  section(`${name} · what is left behind`)
  check(`${name}: nothing stays in Mercury's private folder after a search, and nothing on this disk under the collapsed spelling`, leftBehind().length === 0 && !existsSync(join(project, 'ssh:')), `${leftBehind().join(' ')}`)
}

async function local(world: RemoteWorld): Promise<void> {
  const far = join(world.data, 'proj')
  const there = remote(far)
  section('local · only names travel, and a search that is silent for longer than a dead link is allowed comes back whole')
  closeRemoteConnections()
  const counted = join(world.scratch, 'bytes-from-the-remote')
  process.env.REMOTE_KIT_COUNT = counted
  const listed = await glob({ pattern: '**/*', path: there })
  const travelled = existsSync(counted) ? statSync(counted).size : 0
  closeRemoteConnections()
  delete process.env.REMOTE_KIT_COUNT
  check(`a listing of a tree that holds a 5 MB file brought ${travelled} bytes over the connection`, listed.includes(`${there}/bin/tool`) && travelled > 500 && travelled < 65_536, String(travelled))
  const realFind = Bun.which('find')
  if (realFind === null) {
    console.log('  [SKIP] no find on this machine: a long silent search was not read')
    return
  }
  writeFileSync(join(world.scratch, 'bin', 'find'), ['#!/bin/sh', 'sleep 66', `exec '${realFind}' "$@"`, ''].join('\n'), { mode: 0o755 })
  chmodSync(join(world.scratch, 'bin', 'find'), 0o755)
  closeRemoteConnections()
  const started = Date.now()
  const slow = await glob({ pattern: 'docs/*.md', path: there })
  const took = Date.now() - started
  rmSync(join(world.scratch, 'bin', 'find'))
  closeRemoteConnections()
  check(`a walk that says nothing for 66 seconds on a live link, past the 60 a dead link is given, comes back whole (${Math.round(took / 1000)} s)`, slow === `${there}/docs/guide.md` && took >= 66_000, `${slow} after ${took} ms`)
}

try {
  for (const transport of ['local', 'sshd'] as const) {
    const unavailable = transport === 'local' ? localTransportUnavailable() : sshdUnavailable()
    if (unavailable !== null) {
      console.log(`  [SKIP] the ${transport} transport: ${unavailable}`)
      continue
    }
    const world = await remoteWorld(transport, PORT, { clientHome: HOME })
    const leave = enterWorld(world)
    try {
      await searches(world)
      if (transport === 'local') await local(world)
    } finally {
      closeRemoteConnections()
      leave()
      await world.stop()
    }
  }
} finally {
  process.chdir(tmpdir())
  removeScratch(launch)
}

console.log(`\nremote glob: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
