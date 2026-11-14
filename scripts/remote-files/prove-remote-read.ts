#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-read-')))
const project = join(launch, 'project')
const STORE = join(launch, 'mercury-home')
for (const dir of [project, STORE]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getToolUseSummary } = await import('../../src/tools/FileReadTool/UI.tsx')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, cacheKeys } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

const PORT = 27063
const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 420 seconds')
  process.exit(1)
}, 420_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Rules = { allow?: string[]; deny?: string[]; ask?: string[]; narrowing?: string[]; mode?: string }
type Input = Record<string, unknown> & { file_path: string }
type Data = { type: string; file: { filePath: string; content: string; numLines: number; totalLines: number } }
type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string }; suggestions?: Array<{ rules?: Array<{ toolName: string; ruleContent: string }> }> }

const rulesOf = (rules: Rules = {}) =>
  ({
    ...getEmptyToolPermissionContext(),
    mode: rules.mode ?? 'default',
    alwaysAllowRules: { ...(rules.allow ? { userSettings: rules.allow } : {}), ...(rules.narrowing ? { toolsNarrowing: rules.narrowing } : {}) },
    alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {},
    alwaysAskRules: rules.ask ? { userSettings: rules.ask } : {},
  }) as never
const contextOf = (rules: Rules = {}) =>
  ({
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({ toolPermissionContext: rulesOf(rules) }),
  }) as never
let turns = 0
const own = (): { message: { id: string } } => ({ message: { id: `remote-read-proof-${turns++}` } })
const thrown = (error: unknown): Data => ({ type: 'thrown', file: { filePath: '', content: `THROWN ${error instanceof Error ? error.message : String(error)}`, numLines: 0, totalLines: 0 } })
const call = async (input: Input, context: unknown = contextOf(), canUseTool?: unknown, parent?: unknown): Promise<Data> => {
  try {
    return (await FileReadTool.call(input as never, context as never, canUseTool, parent)).data as unknown as Data
  } catch (error) {
    return thrown(error)
  }
}
const text = (data: Data): string => (data.type === 'thrown' ? data.file.content : String(FileReadTool.mapToolResultToToolResultBlockParam(data as never, 'proof').content))
const said = async (input: Input, context: unknown = contextOf(), canUseTool?: unknown, parent?: unknown): Promise<string> => text(await call(input, context, canUseTool, parent))
const validated = async (input: Input, rules: Rules = {}): Promise<{ result: boolean; message?: string }> => (await FileReadTool.validateInput!(input as never, contextOf(rules))) as { result: boolean; message?: string }
const decided = async (input: Input, rules: Rules = {}): Promise<Decision> => (await FileReadTool.checkPermissions(input as never, contextOf(rules))) as unknown as Decision
const remote = (path: string, host = 'box'): string => `ssh://${host}${path.replaceAll('%', '%25')}`

const FILES: Array<[string, Buffer]> = [
  ['plain.txt', Buffer.from(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n') + '\n')],
  ['no-newline.txt', Buffer.from('alpha\nbeta\ngamma')],
  ['empty.txt', Buffer.alloc(0)],
  ['crlf.txt', Buffer.from('one\r\ntwo\r\nthree\r\nfour\r\n')],
  ['bom.md', Buffer.from('\uFEFF# title\n\nbody\nmore\n')],
  ['utf16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('uno\ndos\ntres\ncuatro\n', 'utf16le')])],
  ['accents.md', Buffer.from('café\nnaïve\n日本語\nñandú\nfin\n')],
  ['code.ts', Buffer.from('export function one(): number {\n  return 1\n}\n\nexport class Two {\n  three(): string {\n    return "3"\n  }\n}\n')],
  ['conflict.txt', Buffer.from('a\n<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\nd\n')],
]
const VARIANTS: Array<Record<string, unknown>> = [
  {},
  { offset: 2, limit: 3 },
  { offset: -3 },
  { offset: -3, limit: 2 },
  { ranges: ['1-2', '4', '-2'] },
  { offset: 1, limit: 4, line_anchors: true },
  { offset: 2, limit: 2, lossless: true },
  { offset: 9999, limit: 5 },
  { limit: 1 },
  { outline: true },
]

async function pages(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · what Read answers for a remote file is what it answers for the same file here`)
  for (const [file, bytes] of FILES) {
    const path = join(world.data, file)
    writeFileSync(path, bytes)
    const wrong: string[] = []
    for (const variant of VARIANTS) {
      const here = await said({ file_path: path, ...variant }, contextOf(), undefined, own())
      const there = await said({ file_path: remote(path), ...variant }, contextOf(), undefined, own())
      if (here !== there) wrong.push(`${JSON.stringify(variant)}: remote ${JSON.stringify(there.slice(0, 160))} local ${JSON.stringify(here.slice(0, 160))}`)
    }
    const selected = await said({ file_path: `${remote(path)}:2-3` }, contextOf(), undefined, own())
    const selectedHere = await said({ file_path: `${path}:2-3` }, contextOf(), undefined, own())
    if (selected !== selectedHere) wrong.push(`:2-3 remote ${JSON.stringify(selected.slice(0, 160))} local ${JSON.stringify(selectedHere.slice(0, 160))}`)
    check(`${name}: ${file}: ${VARIANTS.length + 1} ways of asking, each answer identical`, wrong.length === 0, wrong.join(' | '))
  }
  const plain = await call({ file_path: remote(join(world.data, 'plain.txt')), offset: 3, limit: 2 })
  check(`${name}: the answer names the file by its remote path`, plain.file.filePath === remote(join(world.data, 'plain.txt')) && plain.file.content === 'line 3\nline 4', JSON.stringify(plain.file))
  const literal = join(world.data, 'odd:7')
  writeFileSync(literal, 'a file whose own name ends in a colon and a number\n')
  check(`${name}: a file whose name ends like a line selector is read as that file`, (await said({ file_path: remote(literal) })).includes('a file whose own name ends in a colon and a number'))
  const spaced = join(world.data, 'a name with spaces & $(touch RAN) "quotes".txt')
  writeFileSync(spaced, 'spaced\n')
  check(`${name}: a name with spaces, quotes and a command substitution is that file, and runs nothing`, (await said({ file_path: remote(spaced) })).includes('1\tspaced') && !existsSync(join(world.remoteHome, 'RAN')) && !existsSync(join(world.data, 'RAN')))
  writeFileSync(join(world.data, 'percent 100%.txt'), 'percent\n')
  check(`${name}: an escaped percent and an escaped space name the file`, (await said({ file_path: `ssh://box${world.data}/percent%20100%25.txt` })).includes('1\tpercent'))

  section(`${name} · a large file is read in pages, and only the page travels`)
  const big = join(world.data, 'big.log')
  const row = (index: number): string => `${String(index).padStart(7, '0')} ${'entry '.repeat(12)}`
  const total = 300_000
  writeFileSync(big, Array.from({ length: total }, (_, index) => row(index + 1)).join('\n') + '\n')
  const size = statSync(big).size
  const middle = await call({ file_path: remote(big), offset: 250_000, limit: 5 })
  check(`${name}: five lines from line 250,000 of a ${Math.round(size / 1024 / 1024)} MB file`, middle.file.content === Array.from({ length: 5 }, (_, index) => row(250_000 + index)).join('\n') && middle.file.totalLines === total, JSON.stringify(middle.file).slice(0, 300))
  const tail = await call({ file_path: remote(big), offset: -3 })
  check(`${name}: its last three lines, numbered by the true count`, tail.file.content.replace(/\n$/, '') === Array.from({ length: 3 }, (_, index) => row(total - 2 + index)).join('\n') && tail.file.totalLines === total && text(tail).startsWith(`${total - 2}\t`), JSON.stringify(text(tail).slice(0, 200)))
  const whole = await said({ file_path: remote(big) }, contextOf(), undefined, own())
  const wholeHere = await said({ file_path: big }, contextOf(), undefined, own())
  check(`${name}: read whole, it is refused by its size in the words a local file gets, with the count of its lines`, whole === wholeHere && whole.includes(`${total} lines`) && whole.startsWith('THROWN File content ('), whole.slice(0, 300))
  let walked = 0
  let next = 1
  const seen: string[] = []
  const paged = join(world.data, 'paged.txt')
  writeFileSync(paged, Array.from({ length: 1000 }, (_, index) => `row ${index + 1}`).join('\n') + '\n')
  while (next > 0 && walked < 20) {
    const page = await call({ file_path: remote(paged), offset: next, limit: 300 })
    seen.push(...page.file.content.replace(/\n$/, '').split('\n'))
    const more = /Read\(offset: (\d+), limit: (\d+)\) continues from there/.exec(text(page))
    next = more === null ? 0 : Number(more[1])
    walked++
  }
  check(`${name}: following each answer's own continuation reaches the end, every line once`, walked === 4 && seen.length === 1000 && seen.every((line, index) => line === `row ${index + 1}`), `${walked} pages, ${seen.length} lines`)
  if (world.transport === 'local') {
    closeRemoteConnections()
    const counted = join(world.scratch, 'bytes-from-the-remote')
    process.env.REMOTE_KIT_COUNT = counted
    await call({ file_path: remote(big), offset: 100_000, limit: 5 })
    const travelled = existsSync(counted) ? statSync(counted).size : 0
    closeRemoteConnections()
    delete process.env.REMOTE_KIT_COUNT
    check(`local: that page of the ${Math.round(size / 1024 / 1024)} MB file brought ${travelled} bytes over the connection, not the file`, travelled > 400 && travelled < 16_384, String(travelled))
  }
}

async function folders(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · a folder, a missing file, and what is neither file nor folder`)
  const dir = join(world.data, 'tree')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  for (const file of ['b.txt', 'a.txt', '.hidden', 'Z.md', `we'ird "name".txt`, 'ünï.txt']) writeFileSync(join(dir, file), '')
  symlinkSync('sub', join(dir, 'link-to-sub'))
  const listedHere = await said({ file_path: dir })
  const listed = await said({ file_path: remote(dir) })
  check(`${name}: a folder is listed as the same folder is here`, listed === listedHere && listed.includes('entries: 8 shown of 8') && listed.includes('\tsub/\n'), listed.slice(0, 400))
  check(`${name}: with or without a closing slash`, (await said({ file_path: `${remote(dir)}/` })) === listedHere)
  const crowd = join(world.data, 'crowd')
  mkdirSync(crowd)
  for (let index = 0; index < 260; index++) writeFileSync(join(crowd, `f-${String(index).padStart(3, '0')}`), '')
  const crowded = await said({ file_path: remote(crowd) })
  const crowdedHere = await said({ file_path: crowd })
  check(`${name}: a folder past the listing's width says how many are left and how to narrow, with the remote path in the hint`, crowded === crowdedHere.replace(`Glob(pattern: "${crowd}/<pattern>")`, `Glob(pattern: "${remote(crowd)}/<pattern>")`) && crowded.includes('entries: 200 shown of 260') && crowded.includes(`60 more entries omitted — next action: narrow with Glob(pattern: "${remote(crowd)}/<pattern>")`), crowded.slice(-260))
  mkdirSync(join(world.data, 'hollow'))
  check(`${name}: an empty folder is an empty listing`, (await said({ file_path: remote(join(world.data, 'hollow')) })).includes('entries: 0 shown of 0'))
  writeFileSync(join(world.remoteHome, 'notes.md'), 'from the home\n')
  check(`${name}: ~ is the remote account's home, for a file and for the folder itself`, (await said({ file_path: 'ssh://box/~/notes.md' })).includes('1\tfrom the home') && (await said({ file_path: 'ssh://box' })).includes('notes.md') && (await said({ file_path: 'ssh://box/~' })) === (await said({ file_path: 'ssh://box' })))
  if (process.getuid?.() !== 0) {
    const shut = join(world.data, 'shut')
    mkdirSync(shut)
    chmodSync(shut, 0o000)
    const closed = await said({ file_path: remote(shut) })
    const closedHere = await said({ file_path: shut })
    chmodSync(shut, 0o755)
    check(`${name}: a folder that cannot be read says so, as here, and is not shown empty`, closed === closedHere.replace(`'${shut}'`, `'${remote(shut)}'`) && closed.includes('state: unavailable') && closed.includes('EACCES'), closed)
    const sealed = join(world.data, 'sealed.txt')
    writeFileSync(sealed, 'sealed\n')
    chmodSync(sealed, 0o000)
    const unread = await said({ file_path: remote(sealed) })
    chmodSync(sealed, 0o644)
    check(`${name}: a file that cannot be read is neither missing nor empty`, unread === `THROWN EACCES: permission denied, open '${remote(sealed)}'`, unread)
  }
  writeFileSync(join(dir, 'report.md'), 'report\n')
  check(`${name}: a missing file is said to be missing on that host`, (await said({ file_path: remote(join(dir, 'nothing-like-it.txt')) })) === 'THROWN There is no file at that path on box.')
  check(`${name}: and where one name in the folder differs only by its ending, it is offered`, (await said({ file_path: remote(join(dir, 'report.txt')) })) === `THROWN There is no file at that path on box. Did you mean ${remote(join(dir, 'report.md'))}?`, await said({ file_path: remote(join(dir, 'report.txt')) }))
  check(`${name}: a line selector on a missing file is still a missing file`, (await said({ file_path: `${remote(join(dir, 'nothing.txt'))}:3-9` })) === 'THROWN There is no file at that path on box.')
  check(`${name}: an account that does not exist is said so`, (await said({ file_path: 'ssh://box/~no-such-account-here/x' })) === 'THROWN box has no account named no-such-account-here.')
  const fifo = join(world.data, 'a-pipe')
  spawnSync('mkfifo', [fifo])
  if (existsSync(fifo)) {
    const pipe = await said({ file_path: remote(fifo) })
    const pipeHere = await said({ file_path: fifo })
    check(`${name}: a named pipe is not opened, in the words a local one gets`, pipe === pipeHere.replace(fifo, remote(fifo)) && pipe.includes('it is a named pipe'), pipe)
  }
  check(`${name}: a device is not opened`, (await said({ file_path: 'ssh://box/dev/null' })).includes('is not allowed: it is a device'), await said({ file_path: 'ssh://box/dev/null' }))
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0xfa, 0xfb]))
  check(`${name}: a file whose name says binary, of a kind nothing reads, is refused in today's words`, (await said({ file_path: remote(join(dir, 'blob.bin')) })) === 'THROWN This tool cannot read binary files, and .bin looks binary — reach for a tool built for that format instead.')
  writeFileSync(join(dir, 'be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hi\n', 'utf16le').swap16()]))
  check(`${name}: a UTF-16BE file is refused in the words a local one gets`, (await said({ file_path: remote(join(dir, 'be.txt')) })) === (await said({ file_path: join(dir, 'be.txt') })) && (await said({ file_path: remote(join(dir, 'be.txt')) })).startsWith('THROWN File is UTF-16BE'))
  check(`${name}: the tool row names the path as it was written`, getToolUseSummary({ file_path: remote(join(dir, 'a.txt')) }) === remote(join(dir, 'a.txt')) || (getToolUseSummary({ file_path: remote(join(dir, 'a.txt')) }) ?? '').startsWith('ssh://box/'), String(getToolUseSummary({ file_path: remote(join(dir, 'a.txt')) })))
}

async function ledger(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · a second read of the same thing`)
  const file = join(world.data, 'steady.txt')
  writeFileSync(file, 'steady one\nsteady two\n')
  utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  const context = contextOf()
  const first = await call({ file_path: remote(file) }, context)
  const second = await call({ file_path: remote(file) }, context)
  check(`${name}: unchanged, it is answered by the short line that says so`, first.type === 'text' && second.type === 'file_unchanged' && second.file.filePath === remote(file), `${first.type} ${second.type}`)
  check(`${name}: the read ledger keeps it under the remote path`, JSON.stringify(cacheKeys((context as { readFileState: never }).readFileState)) === JSON.stringify([remote(file)]), JSON.stringify(cacheKeys((context as { readFileState: never }).readFileState)))
  writeFileSync(file, 'steady 1ne\nsteady two\n')
  utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  const third = await call({ file_path: remote(file) }, context)
  check(`${name}: one byte changed, with the same size and the same time, it is read again`, third.type === 'text' && third.file.content.startsWith('steady 1ne'), `${third.type}`)
}

async function rulesAndFloors(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · nothing reaches the remote machine before the decision`)
  const data = world.data
  const secretDir = join(data, 'secret')
  mkdirSync(secretDir, { recursive: true })
  writeFileSync(join(secretDir, 'key.txt'), 'THE-KEY\n')
  writeFileSync(join(data, 'open.txt'), 'open\n')
  symlinkSync(secretDir, join(data, 'door'))
  symlinkSync(join(secretDir, 'key.txt'), join(data, 'innocent.txt'))
  closeRemoteConnections()
  await new Promise(resolve => setTimeout(resolve, 2_200))
  const started = world.argvLines().length
  const connected = world.connectLines().length
  const openInput = { file_path: remote(join(data, 'open.txt')) }
  const valid = await validated(openInput)
  const ask = await decided(openInput)
  check(`${name}: checking the input and reading the rules ask the ssh configuration what the name resolves to, and start no connection`, valid.result === true && world.connectLines().length === connected && world.argvLines().slice(started).some(line => line === '-G -- box'), world.argvLines().slice(started).join(' | '))
  check(`${name}: with no rule, the default mode asks, and offers the host for the session`, ask.behavior === 'ask' && ask.decisionReason?.type === 'workingDir' && JSON.stringify(ask.suggestions?.[0]?.rules) === JSON.stringify([{ toolName: 'Read', ruleContent: 'ssh://box/**' }]), JSON.stringify(ask))
  const allowed = await decided(openInput, { allow: ['Read(ssh://box/**)'] })
  check(`${name}: a rule for the host allows`, allowed.behavior === 'allow', JSON.stringify(allowed))
  const malformed: Array<[string, RegExp]> = [
    ['ssh://user:S3CR3T@box/x', /^ssh:\/\/user@box\/x was written with a password/],
    ['ssh://$(touch RAN)/x', /names no host\.$|a shell would act on\.$/],
    ['ssh://a;b/x', /has a character in its host or its user that a shell would act on\.$/],
    ['ssh://-oProxyCommand=id/x', /begins a host or a user with a dash/],
    ['ssh:///etc/hosts', /names no host: write ssh:\/\/<host>\/etc\/hosts\.$/],
  ]
  const before = world.argvLines().length
  const refusals = await Promise.all(malformed.map(([path]) => validated({ file_path: path })))
  check(`${name}: a path that is not one is refused in words, and starts no ssh of any kind`, refusals.every((refusal, index) => refusal.result === false && malformed[index]![1].test(refusal.message ?? '')) && world.argvLines().length === before && !refusals.some(refusal => /S3CR3T/.test(refusal.message ?? '')), refusals.map(refusal => refusal.message).join(' | '))

  section(`${name} · a deny rule holds, however the file is reached`)
  const deny = { allow: ['Read(ssh://box/**)'], deny: [`Read(ssh://box${secretDir}/**)`] }
  const reached = world.connectLines().length
  const direct = await validated({ file_path: remote(join(secretDir, 'key.txt')) }, deny)
  check(`${name}: by its own path, before anything connects, in the deny sentence`, direct.result === false && direct.message === `Reading ${remote(join(secretDir, 'key.txt'))} is denied by the rule Read(ssh://box${secretDir}/**) in your user settings.` && world.connectLines().length === reached, String(direct.message))
  const withSelector = await validated({ file_path: `${remote(join(secretDir, 'key.txt'))}:1-2` }, deny)
  check(`${name}: with a line selector after it`, withSelector.result === false, String(withSelector.message))
  const dotted = await validated({ file_path: remote(join(data, 'tree', '..', 'secret', 'key.txt')) }, deny)
  check(`${name}: by a path that climbs out and back`, dotted.result === false, String(dotted.message))
  for (const [how, path] of [
    ['through a folder that is a link', join(data, 'door', 'key.txt')],
    ['through a file that is a link', join(data, 'innocent.txt')],
  ] as Array<[string, string]>) {
    const passes = await validated({ file_path: remote(path) }, deny)
    const refused = await said({ file_path: remote(path) }, contextOf(deny))
    check(`${name}: ${how}: the written path names no denied folder, and the read is refused once the remote machine has said where it leads`, passes.result === true && refused.startsWith('THROWN Reading ') && refused.includes('is denied by the rule') && !refused.includes('THE-KEY'), refused)
  }
  const byAddress = await validated({ file_path: remote(join(secretDir, 'key.txt')) }, { deny: [`Read(ssh://127.0.0.1/**)`] })
  check(`${name}: a rule written for the address the name resolves to holds for the name`, byAddress.result === false, String(byAddress.message))
  const home = world.remoteHome
  mkdirSync(join(home, 'private'), { recursive: true })
  writeFileSync(join(home, 'private', 'p.txt'), 'PRIVATE\n')
  const tilde = { allow: ['Read(ssh://box/**)'], deny: ['Read(ssh://box/~/private/**)'] }
  const absolute = await said({ file_path: remote(join(home, 'private', 'p.txt')) }, contextOf(tilde))
  const viaTilde = await validated({ file_path: 'ssh://box/~/private/p.txt' }, tilde)
  check(`${name}: a rule written from the home holds for the same file written from the root`, viaTilde.result === false && absolute.startsWith('THROWN Reading ') && absolute.includes('is denied by the rule Read(ssh://box/~/private/**)') && !absolute.includes('PRIVATE'), absolute)
  const listing = await said({ file_path: remote(data) }, contextOf(deny))
  check(`${name}: a listing leaves out what is denied and the links that lead into it`, !/\tsecret\/$/m.test(listing) && !/\tdoor$/m.test(listing) && !/\tinnocent\.txt$/m.test(listing) && /\topen\.txt$/m.test(listing), listing.slice(0, 600))
  const narrowed = await decided(openInput, { narrowing: [`Read(ssh://box${join(data, 'tree')}/**)`] })
  check(`${name}: a tool set narrowed to one remote folder refuses a file beside it`, narrowed.behavior === 'deny', JSON.stringify(narrowed))
  const local = await decided({ file_path: remote(join(data, 'open.txt')) }, { allow: [`Read(/${data}/**)`, 'Read(//private/**)', 'Read(//tmp/**)'] })
  check(`${name}: a rule for the same path on this machine says nothing about the remote one`, local.behavior === 'ask', JSON.stringify(local))

  section(`${name} · a rule that asks, met only where the path leads`)
  const asked: string[] = []
  const askRules = { allow: ['Read(ssh://box/**)'], ask: [`Read(ssh://box${secretDir}/**)`] }
  const yes = async (_tool: unknown, input: Input): Promise<unknown> => {
    asked.push(input.file_path)
    return { behavior: 'allow', updatedInput: input }
  }
  const no = async (_tool: unknown, input: Input): Promise<unknown> => {
    asked.push(input.file_path)
    return { behavior: 'deny', message: 'The operator said no.', decisionReason: { type: 'other', reason: 'no' } }
  }
  const through = await said({ file_path: remote(join(data, 'innocent.txt')) }, contextOf(askRules), yes, own())
  check(`${name}: the question is put for the path the link leads to, once, and a yes reads the file`, asked.length === 1 && asked[0] === remote(join(secretDir, 'key.txt')) && through.includes('1\tTHE-KEY'), `${JSON.stringify(asked)} ${through.slice(0, 120)}`)
  const declined = await said({ file_path: remote(join(data, 'innocent.txt')) }, contextOf(askRules), no, own())
  check(`${name}: a no reads nothing`, declined === 'THROWN The operator said no.', declined)
  const nobodyToAsk = await said({ file_path: remote(join(data, 'innocent.txt')) }, contextOf(askRules))
  check(`${name}: with nobody to ask, the rule's own sentence refuses`, nobodyToAsk.startsWith('THROWN Reading ') && nobodyToAsk.includes('asks first') && !nobodyToAsk.includes('THE-KEY'), nobodyToAsk)
  asked.length = 0
  const answeredAlready = await said({ file_path: remote(join(secretDir, 'key.txt')) }, contextOf(askRules), yes, own())
  check(`${name}: a path the rule matched as written is not asked about a second time`, asked.length === 0 && answeredAlready.includes('1\tTHE-KEY'), JSON.stringify(asked))

  section(`${name} · Mercury's own credentials on this machine`)
  const secret = join(STORE, '.credentials.json')
  writeFileSync(secret, '{"token":"STORE-TOKEN"}\n')
  symlinkSync(STORE, join(data, 'link-to-store'))
  const refusedByName = await decided({ file_path: remote(secret) }, { mode: 'sovereign', allow: ['Read(ssh://box/**)'] })
  const refusedInCall = await said({ file_path: remote(secret) }, contextOf({ allow: ['Read(ssh://box/**)'] }))
  check(`${name}: the store reached through a host that is this machine is refused at the decision and again at the read`, refusedByName.behavior === 'deny' && /holds Mercury's own credentials/.test(refusedByName.message ?? '') && /^THROWN Reading .* is refused: .* holds Mercury's own credentials/.test(refusedInCall) && !refusedInCall.includes('STORE-TOKEN'), `${refusedByName.message} | ${refusedInCall}`)
  const viaLink = await said({ file_path: remote(join(data, 'link-to-store', '.credentials.json')) }, contextOf({ allow: ['Read(ssh://box/**)'] }))
  check(`${name}: and through a link on the remote side`, /holds Mercury's own credentials/.test(viaLink) && !viaLink.includes('STORE-TOKEN'), viaLink)
  const storeListing = await said({ file_path: remote(STORE) }, contextOf({ allow: ['Read(ssh://box/**)'] }))
  check(`${name}: a listing of the store's folder does not name the store`, !storeListing.includes('.credentials.json') && storeListing.includes('(target: directory'), storeListing.slice(0, 300))
  if (world.transport === 'local') {
    const far = (path: string): string => remote(path, 'far')
    const farDecision = await decided({ file_path: far(secret) }, { allow: ['Read(ssh://far/**)'] })
    const farRead = await said({ file_path: far(secret) }, contextOf({ allow: ['Read(ssh://far/**)'] }))
    check('local: a host whose name says nothing, found to be this machine once connected, is refused the store all the same', farDecision.behavior === 'allow' && /^THROWN Reading .* is refused: .* holds Mercury's own credentials/.test(farRead) && !farRead.includes('STORE-TOKEN'), `${farDecision.behavior} | ${farRead}`)
    const farListing = await said({ file_path: far(STORE) }, contextOf({ allow: ['Read(ssh://far/**)'] }))
    check('local: and its listing of that folder leaves the store out', !farListing.includes('.credentials.json') && farListing.includes('(target: directory'), farListing.slice(0, 300))
    check('local: an ordinary file on that host is read', (await said({ file_path: far(join(data, 'open.txt')) })).includes('1\topen'))
  }
}

async function unusable(world: RemoteWorld): Promise<void> {
  const name = world.transport
  section(`${name} · hosts that cannot be used`)
  const stranger = await said({ file_path: 'ssh://stranger/etc/hosts' })
  check(`${name}: a host whose key is not known: ssh's own words, nothing read`, /^THROWN ssh could not reach stranger: .*Host key verification failed\.$/.test(stranger), stranger)
  const nobody = await said({ file_path: 'ssh://nobody/etc/hosts' })
  check(`${name}: a host that does not answer`, /^THROWN ssh could not reach nobody: .*Connection refused/.test(nobody), nobody)
  if (world.transport === 'local') {
    const windows = await said({ file_path: 'ssh://windows/C:/Users/x/file.txt' })
    check('local: a remote machine with no POSIX shell is said to have none', windows.startsWith('THROWN windows has no POSIX shell that answers') && windows.endsWith('a path that begins ssh:// needs sh, bash or zsh on the remote machine.'), windows)
  }
}

async function hostList(world: RemoteWorld): Promise<void> {
  section('local · ssh:// alone lists the hosts of the ssh configuration')
  const sshDir = join(world.clientHome, '.ssh')
  mkdirSync(join(sshDir, 'conf.d'), { recursive: true })
  writeFileSync(
    join(sshDir, 'config'),
    ['# a comment', 'Host web1 web2 *.internal !bastion', '  HostName 10.0.0.5', 'Include conf.d/*.conf', 'host=db-primary', 'Host "quoted name" plain # trailing words', 'Host *', '  User deploy', 'Match host web9', '  User nobody', ''].join('\n'),
  )
  writeFileSync(join(sshDir, 'conf.d', 'b.conf'), 'Host staging\nHost web1\n')
  writeFileSync(join(sshDir, 'conf.d', 'a.conf'), 'Host build-box\n  Include loop.conf\n')
  writeFileSync(join(sshDir, 'loop.conf'), 'Host looped\nInclude config\n')
  writeFileSync(join(sshDir, 'conf.d', 'ignored.txt'), 'Host not-included\n')
  closeRemoteConnections()
  const before = world.argvLines().length
  const listed = await said({ file_path: 'ssh://' })
  const expected = ['web1', 'web2', 'build-box', 'looped', 'staging', 'db-primary', 'plain']
  const body = listed.split('\n').map(line => line.replace(/^\d+\t/, ''))
  check('the names of the configuration and of what it includes, each once, patterns left out, each as a path', body[0] === `(target: ssh hosts · owner: Read · ${expected.length} from the ssh configuration)` && JSON.stringify(body.slice(1, 1 + expected.length)) === JSON.stringify(expected.map(host => `ssh://${host}/`)) && body[1 + expected.length] === 'Any destination ssh accepts is a path too: ssh://user@host:port/absolute/path.', listed.slice(0, 500))
  check('listing them starts no ssh', world.argvLines().length === before, world.argvLines().slice(before).join(' | '))
  const asked = await decided({ file_path: 'ssh://' })
  check('in the default mode it asks first, as a read of the configuration, and offers no rule', asked.behavior === 'ask' && asked.decisionReason?.reason === 'the host list is read from ~/.ssh/config' && (asked.suggestions ?? []).length === 0, JSON.stringify(asked))
  const denied = await decided({ file_path: 'ssh://' }, { deny: [`Read(/${sshDir}/**)`] })
  check('a rule that denies the configuration file denies the list, in the deny sentence, naming the file', denied.behavior === 'deny' && (denied.message ?? '').includes(join(sshDir, 'config')) && (denied.message ?? '').includes('is denied by the rule'), JSON.stringify(denied))
  const partly = await said({ file_path: 'ssh://' }, contextOf({ deny: [`Read(/${join(sshDir, 'conf.d')}/**)`] }))
  check('an included file under a deny rule is not opened: its hosts are not listed', !partly.includes('ssh://staging/') && !partly.includes('ssh://build-box/') && partly.includes('ssh://web1/') && partly.includes('ssh://plain/'), partly.slice(0, 400))
  const allowed = await decided({ file_path: 'ssh://' }, { allow: [`Read(/${sshDir}/**)`] })
  check('a rule that allows the configuration file allows the list', allowed.behavior === 'allow', JSON.stringify(allowed))
  writeFileSync(join(sshDir, 'config'), 'Host *\n  User deploy\n')
  const none = await said({ file_path: 'ssh://' })
  check('a configuration that names no host is an honest empty list', none.split('\n')[0]!.endsWith('(target: ssh hosts · owner: Read · 0 from the ssh configuration)') && none.includes('Any destination ssh accepts is a path too'), none.slice(0, 300))
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
      await pages(world)
      await folders(world)
      await ledger(world)
      await rulesAndFloors(world)
      await unusable(world)
      if (transport === 'local') await hostList(world)
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

console.log(`\nremote read: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
