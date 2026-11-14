#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-grep-')))
const project = join(launch, 'project')
const STORE = join(launch, 'mercury-home')
const TWINS = join(launch, 'twins')
const PRIVATE = join(launch, 'private-tmp')
const FIXTURES = join(import.meta.dir, '..', 'tools', 'fixtures', 'read-formats')
for (const dir of [project, STORE, TWINS]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_TMPDIR = PRIVATE
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.MERCURY_GREP_RANKED = '1'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
const { ripgrepCommand } = await import('../../src/utils/ripgrep.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

const PORT = 27068
const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 480 seconds')
  process.exit(1)
}, 480_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 1100)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Rules = { allow?: string[]; deny?: string[]; mode?: string }
type Input = Record<string, unknown> & { pattern: string; path?: string }
type Decision = { behavior: string; message?: string; suggestions?: Array<{ rules?: Array<{ toolName: string; ruleContent: string }> }> }
const rulesOf = (rules: Rules = {}) =>
  ({
    ...getEmptyToolPermissionContext(),
    mode: rules.mode ?? 'sovereign',
    alwaysAllowRules: rules.allow ? { userSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {},
  }) as never
const contextOf = (rules: Rules = {}, abortController = new AbortController()) =>
  ({
    messages: [],
    options: { engineModel: 'claude-opus-4-8', tools: [] },
    readFileState: createFileStateCacheWithSizeLimit(100),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController,
    getAppState: () => ({ toolPermissionContext: rulesOf(rules) }),
  }) as never
const thrown = (error: unknown): string => `THROWN ${error instanceof Error ? error.message : String(error)}`
const grep = async (input: Input, rules: Rules = {}, abortController?: AbortController): Promise<string> => {
  try {
    const context = contextOf(rules, abortController)
    const verdict = (await GrepTool.validateInput!(input as never, context)) as { result: boolean; message?: string }
    if (verdict.result === false) return `THROWN ${verdict.message}`
    const result = await GrepTool.call(input as never, context, undefined as never, { message: { id: 'remote-grep' } } as never)
    return String(GrepTool.mapToolResultToToolResultBlockParam(result.data as never, 'proof').content)
  } catch (error) {
    return thrown(error)
  }
}
const validated = async (input: Input, rules: Rules = {}): Promise<{ result: boolean; message?: string }> => {
  try {
    return (await GrepTool.validateInput!(input as never, contextOf(rules))) as { result: boolean; message?: string }
  } catch (error) {
    return { result: false, message: thrown(error) }
  }
}
const decided = async (input: Input, rules: Rules = {}): Promise<Decision> => {
  try {
    return (await GrepTool.checkPermissions(input as never, contextOf(rules))) as unknown as Decision
  } catch (error) {
    return { behavior: 'thrown', message: thrown(error) }
  }
}
const remote = (path: string): string => `ssh://box${path}`
const namesIn = (path: string): string[] => (existsSync(path) && statSync(path).isDirectory() ? readdirSync(path, { recursive: true }).map(String) : [])
const leftBehind = (): string[] => namesIn(PRIVATE).filter(name => name.includes('copy-'))
const NO_RIPGREP = ': it has no ripgrep; with rg installed there the search runs on the host'
const READ_FROM = /\n\(read (\d+) files?, ([^,:]+), from box(: [^)]*)?\)$/
const body = (answer: string): string => answer.replace(READ_FROM, '')
const lines = (answer: string): string => answer.split('\n').sort().join('\n')
const read = (answer: string): { files: number; size: string; tail: string } | null => {
  const found = READ_FROM.exec(answer)
  return found === null ? null : { files: Number(found[1]), size: found[2]!, tail: found[3] ?? '' }
}

const MANY = Array.from({ length: 40 }, (_, index) => `needle number ${index + 1}`).join('\n') + '\n'
const TREE: Array<[string, string | Buffer]> = [
  ['README.md', '# proj\n\nThe server will listen on a port.\nSecond paragraph.\n'],
  ['.gitignore', 'dist/\n*.log\nnode_modules/\n'],
  ['src/a.ts', 'export const port = 8080\nserver.listen(port)\nconst after = 1\n'],
  ['src/b.ts', 'import { port } from "./a"\nconsole.log(port)\n'],
  ['src/deep/c.ts', '// Listen later\nexport {}\n'],
  ['src/my file.ts', 'const spaced = "listen"\n'],
  ['src/multi.ts', 'function start(\n  port,\n) {\n  return port\n}\n'],
  ['src/many.txt', MANY],
  ['docs/guide.md', 'How to listen.\n\nMore about it\'s "quoted" words.\n'],
  ['dist/out.js', 'listen()\n'],
  ['app.log', 'listen listen\n'],
  ['.env', 'SECRET=listen\n'],
  ['node_modules/x/index.js', 'module.exports = "listen"\n'],
  ['.git/config', '[core]\n\tlisten = no\n'],
  ['bin/tool', Buffer.concat([Buffer.from('\u007fELF\u0000\u0000listen'), Buffer.alloc(2 * 1024 * 1024, 1)])],
  ['notes/big.txt', `${'filler line\n'.repeat(120_000)}listen at the end\n`],
]
function plant(root: string): void {
  TREE.forEach(([name, bytes], index) => {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), bytes)
    const at = new Date(1_700_000_000_000 + index * 60_000)
    utimesSync(join(root, name), at, at)
  })
  for (const file of ['sample.docx', 'sample.rtf']) copyFileSync(join(FIXTURES, file), join(root, 'docs', file))
  symlinkSync('a.ts', join(root, 'src', 'link.ts'))
  symlinkSync('docs', join(root, 'docs-link'))
}

const ASKS: Array<[string, Record<string, unknown>]> = [
  ['the files that match', { pattern: 'listen' }],
  ['the lines that match', { pattern: 'listen', output_mode: 'content' }],
  ['the counts', { pattern: 'listen', output_mode: 'count' }],
  ['without regard to case', { pattern: 'LISTEN', '-i': true, output_mode: 'content' }],
  ['a regular expression', { pattern: 'port\\s*=\\s*\\d+', output_mode: 'content' }],
  ['a literal with a regex character in it', { pattern: 'server.listen(port)', literal: true, output_mode: 'content' }],
  ['a glob', { pattern: 'listen', glob: '*.ts', output_mode: 'content' }],
  ['a glob with a folder in it', { pattern: 'listen', glob: 'src/**/*.ts' }],
  ['a glob with alternatives', { pattern: 'listen', glob: '*.{ts,md}' }],
  ['a glob that leaves files out', { pattern: 'listen', glob: '!*.md' }],
  ['a type', { pattern: 'listen', type: 'md', output_mode: 'content' }],
  ['lines of context', { pattern: 'listen', glob: '*.ts', output_mode: 'content', context: 1 }],
  ['lines before and after', { pattern: 'listen', glob: 'a.ts', output_mode: 'content', '-B': 1, '-A': 1 }],
  ['across lines', { pattern: 'start\\([\\s\\S]*?\\) \\{', multiline: true, output_mode: 'content' }],
  ['a first page', { pattern: 'needle', output_mode: 'content', head_limit: 5 }],
  ['a later page', { pattern: 'needle', output_mode: 'content', head_limit: 5, offset: 10 }],
  ['more matches in one file than one answer shows of a file', { pattern: 'needle', output_mode: 'content' }],
  ['words inside documents', { pattern: 'Rich Text Heading', output_mode: 'content' }],
  ['nothing found', { pattern: 'zebra-crossing' }],
  ['ranked by what the words describe', { pattern: 'server listen port', output_mode: 'ranked' }],
]

async function asTheTwin(name: string, there: string, near: string, asks: Array<[string, Record<string, unknown>]>, tail: string): Promise<void> {
  for (const [label, more] of asks) {
    const answer = await grep({ ...more, pattern: String(more.pattern), path: there })
    const here = (await grep({ ...more, pattern: String(more.pattern), path: near }, { allow: [`Read(/${near}/**)`] })).replaceAll(near, there)
    const ordered = more.output_mode === undefined || more.output_mode === 'ranked'
    check(`${name}: ${label}`, (ordered ? body(answer) === here : lines(body(answer)) === lines(here)) && !answer.startsWith('THROWN') && read(answer)?.tail === tail, `remote ${JSON.stringify(answer.slice(0, 500))} local ${JSON.stringify(here.slice(0, 500))}`)
  }
}

async function searches(world: RemoteWorld): Promise<void> {
  const name = world.transport
  const far = join(world.data, 'proj')
  const near = join(TWINS, name, 'proj')
  plant(far)
  plant(near)
  const there = remote(far)
  const allowedHere = { allow: [`Read(/${near}/**)`] }

  section(`${name} · what Grep answers for another machine is what it answers for the same tree here`)
  await asTheTwin(name, there, near, ASKS, NO_RIPGREP)
  const documents = await grep({ pattern: 'Rich Text Heading', output_mode: 'content', path: there })
  check(`${name}: a document on the remote machine is searched as its text`, documents.includes(`${there}/docs/sample.rtf`), documents.slice(0, 400))
  const one = await grep({ pattern: 'port', output_mode: 'content', path: `${there}/src/a.ts` })
  const oneHere = (await grep({ pattern: 'port', output_mode: 'content', path: `${near}/src/a.ts` }, allowedHere)).replaceAll(near, there)
  check(`${name}: a single file given as the path`, body(one) === oneHere && read(one)?.files === 1, `${one} | ${oneHere}`)
  const linked = await grep({ pattern: 'listen', path: `${there}/docs-link` })
  check(`${name}: a path that is a link is searched, and answers under the link as written`, body(linked).includes(`${there}/docs-link/guide.md`), linked)
  mkdirSync(join(world.remoteHome, 'homed'), { recursive: true })
  writeFileSync(join(world.remoteHome, 'homed', 'h.txt'), 'listen at home\n')
  const homed = await grep({ pattern: 'listen', output_mode: 'content', path: 'ssh://box/~/homed' })
  check(`${name}: a path under the account's home answers under ~`, body(homed) === 'ssh://box/~/homed/h.txt:1:listen at home', homed)

  section(`${name} · what travels`)
  const all = await grep({ pattern: 'listen', path: there })
  check(`${name}: the answer closes with how many files were read from the host and how much, and that the host has no ripgrep`, read(all)?.files === 13 && read(all)?.tail === NO_RIPGREP, all.slice(-160))
  check(`${name}: files under an ignore rule, and what is in a folder of the version control, are neither read nor found`, !all.includes('dist/out.js') && !all.includes('app.log') && !all.includes('node_modules') && !all.includes('.git/config'), all)
  check(`${name}: a large binary file is cut where ripgrep stops: the 2 MB one costs its first 512 bytes`, /^1\.[0-9] MB$/.test(read(all)?.size ?? ''), String(read(all)?.size))
  const wideFar = join(world.data, 'wide')
  const wideNear = join(TWINS, name, 'wide')
  const wide = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${'filler line\r\n'.repeat(60_000)}listen in sixteen bits\r\n`, 'utf16le')])
  for (const root of [wideFar, wideNear]) {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'wide.txt'), wide)
  }
  const sixteen = await grep({ pattern: 'sixteen', output_mode: 'content', path: remote(wideFar) })
  const sixteenHere = (await grep({ pattern: 'sixteen', output_mode: 'content', path: wideNear }, { allow: [`Read(/${wideNear}/**)`] })).replaceAll(wideNear, remote(wideFar))
  check(`${name}: a file of 16-bit text over a megabyte, which ripgrep reads through its mark, comes whole and is answered as the same file here is`, body(sixteen) === sixteenHere && sixteenHere.includes('listen in sixteen bits'), `${JSON.stringify(sixteen.slice(0, 300))} | ${JSON.stringify(sixteenHere.slice(0, 300))}`)
  const deep = Buffer.concat([Buffer.from('\u007fELF\u0000\u0000'), Buffer.alloc(1_500_000, 1), Buffer.from('\nlisten far inside\n')])
  for (const root of [wideFar, wideNear]) writeFileSync(join(root, 'deep.bin'), deep)
  const walked = await grep({ pattern: 'listen', path: remote(wideFar) })
  const walkedHere = (await grep({ pattern: 'listen', path: wideNear }, { allow: [`Read(/${wideNear}/**)`] })).replaceAll(wideNear, remote(wideFar))
  check(`${name}: in a folder, a large file with a null byte near its start is left where ripgrep leaves a file it walked to, and the 16-bit one beside it is found`, body(walked) === walkedHere && walkedHere.includes('wide.txt') && !walkedHere.includes('deep.bin'), `${JSON.stringify(walked.slice(0, 300))} | ${JSON.stringify(walkedHere.slice(0, 300))}`)
  const handed = await grep({ pattern: 'listen', path: remote(join(wideFar, 'deep.bin')) })
  const handedHere = (await grep({ pattern: 'listen', path: join(wideNear, 'deep.bin') }, { allow: [`Read(/${wideNear}/**)`] })).replaceAll(wideNear, remote(wideFar))
  check(`${name}: the same file given as the path itself is searched to its end, as ripgrep searches a file it is handed`, body(handed) === handedHere && handedHere.includes('deep.bin'), `${JSON.stringify(handed.slice(0, 300))} | ${JSON.stringify(handedHere.slice(0, 300))}`)
  const narrow = await grep({ pattern: 'listen', glob: '*.md', path: there })
  check(`${name}: with a glob only the files it selects are read`, read(narrow)?.files === 2 && / bytes$/.test(read(narrow)?.size ?? ''), narrow.slice(-120))

  section(`${name} · what a search of another machine answers in words of its own`)
  check(`${name}: a path that is not there`, (await grep({ pattern: 'x', path: `${there}/nope` })) === 'THROWN There is no file or folder at that path on box.', await grep({ pattern: 'x', path: `${there}/nope` }))
  check(`${name}: ssh:// alone`, (await grep({ pattern: 'x', path: 'ssh://' })) === 'THROWN ssh:// alone is the list of hosts, which Read shows; a search needs a host: ssh://<host>/<folder>.', await grep({ pattern: 'x', path: 'ssh://' }))

  section(`${name} · the rules`)
  closeRemoteConnections()
  const connected = world.connectLines().length
  const asked = await decided({ pattern: 'listen', path: there }, { mode: 'default' })
  const shaped = await validated({ pattern: 'listen', path: there }, { mode: 'default' })
  check(`${name}: with no rule the default mode asks and offers reading from the host for the session; neither the question nor the check of the input makes a connection`, asked.behavior === 'ask' && JSON.stringify(asked.suggestions?.[0]?.rules) === JSON.stringify([{ toolName: 'Read', ruleContent: 'ssh://box/**' }]) && shaped.result === true && world.connectLines().length === connected, `${JSON.stringify(asked)} ${JSON.stringify(shaped)}`)
  check(`${name}: a rule that allows reading on the host allows the search`, (await decided({ pattern: 'listen', path: there }, { mode: 'default', allow: ['Read(ssh://box/**)'] })).behavior === 'allow')
  const deny = { mode: 'default', allow: ['Read(ssh://box/**)'], deny: [`Read(ssh://box${far}/docs/**)`] }
  const refused = await validated({ pattern: 'listen', path: `${there}/docs` }, deny)
  check(`${name}: a deny rule on the folder refuses the search by its own path, before anything connects`, refused.result === false && refused.message === `Searching ${there}/docs is denied by the rule Read(ssh://box${far}/docs/**) in your user settings.`, String(refused.message))
  const filtered = await grep({ pattern: 'listen', path: there }, deny)
  check(`${name}: files under a denied folder are neither found nor read by a search from above it`, !filtered.includes('/docs/') && filtered.includes(`${there}/README.md`) && read(filtered)?.files === 10, filtered)
  const through = await grep({ pattern: 'listen', path: `${there}/docs-link` }, deny)
  check(`${name}: and a search rooted at a link into the denied folder is refused once the remote machine has said where it leads`, through.startsWith('THROWN ') && through.includes('is denied by the rule'), through)
  const env = await grep({ pattern: 'SECRET', output_mode: 'content', path: there }, { mode: 'default', allow: ['Read(ssh://box/**)'] })
  const envHere = (await grep({ pattern: 'SECRET', output_mode: 'content', path: near }, { mode: 'default', allow: [`Read(/${near}/**)`] })).replaceAll(near, there)
  check(`${name}: an environment file under a folder the user allowed is answered as the same folder here is`, lines(body(env)) === lines(envHere), `${env} | ${envHere}`)
  mkdirSync(join(STORE, 'runtime', 'current'), { recursive: true })
  writeFileSync(join(STORE, '.credentials.json'), '{"secret":"never-printed"}\n')
  writeFileSync(join(launch, 'beside-the-store.txt'), 'a secret beside the store\n')
  const above = await grep({ pattern: 'secret', output_mode: 'content', path: remote(launch) }, { mode: 'default', allow: ['Read(ssh://box/**)'] })
  check(`${name}: on this machine a search from above Mercury's own store finds nothing in its credentials`, above.includes('beside-the-store.txt') && !above.includes('never-printed') && !above.includes('.credentials.json'), above.slice(0, 600))
  rmSync(join(STORE, 'runtime'), { recursive: true, force: true })
  rmSync(join(STORE, '.credentials.json'), { force: true })

  section(`${name} · a remote machine that has ripgrep: the search runs there, and only the files that match are read`)
  const mine = ripgrepCommand() as { rgPath: string; argv0?: string }
  if (mine.argv0 !== undefined) console.log(`  [SKIP] ${name}: Mercury's own ripgrep is inside its runtime here and cannot stand in for one on the remote machine`)
  else {
    const wrapper = join(world.scratch, 'bin', 'rg')
    writeFileSync(wrapper, `#!/bin/sh\nexec '${mine.rgPath}' "$@"\n`)
    chmodSync(wrapper, 0o755)
    closeRemoteConnections()
    await asTheTwin(`${name}, ripgrep there`, there, near, ASKS, '')
    const fewer = await grep({ pattern: 'listen', path: there })
    check(`${name}: nine files are read where thirteen were: the seven that hold the word, and the two documents`, read(fewer)?.files === 9 && read(fewer)?.tail === '', fewer.slice(-160))
    const narrowed = await grep({ pattern: 'port = 8080', literal: true, output_mode: 'content', path: there })
    check(`${name}: a literal that one file holds brings that file and the documents`, read(narrowed)?.files === 3 && body(narrowed) === `${there}/src/a.ts:1:export const port = 8080`, narrowed)
    const looking = await grep({ pattern: '(?<=server\\.)listen', output_mode: 'content', path: there })
    const lookingHere = (await grep({ pattern: '(?<=server\\.)listen', output_mode: 'content', path: near }, allowedHere)).replaceAll(near, there)
    check(`${name}: a pattern the remote ripgrep refuses is searched here over every selected file, and answered as the same tree here is`, lines(body(looking)) === lines(lookingHere) && read(looking)?.files === 13 && read(looking)?.tail === '', `${looking.slice(0, 400)} | ${lookingHere.slice(0, 300)}`)
    writeFileSync(wrapper, '#!/bin/sh\nexit 127\n')
    chmodSync(wrapper, 0o755)
    closeRemoteConnections()
  }

  section(`${name} · what is left behind`)
  const stopping = new AbortController()
  const stopped = grep({ pattern: 'listen', path: there }, {}, stopping)
  stopping.abort()
  const interrupted = await stopped
  check(`${name}: a search that is interrupted ends, and leaves nothing`, interrupted.startsWith('THROWN ') && leftBehind().length === 0, `${interrupted.slice(0, 200)} ${leftBehind().join(' ')}`)
  check(`${name}: nothing stays in Mercury's private folder after a search, and nothing on this disk under the collapsed spelling`, leftBehind().length === 0 && !existsSync(join(project, 'ssh:')), leftBehind().join(' '))
  const after = await grep({ pattern: 'listen', glob: '*.md', path: there })
  check(`${name}: and the next search is answered`, read(after)?.files === 2, after)
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

console.log(`\nremote grep: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
