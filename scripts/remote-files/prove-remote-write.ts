#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-write-')))
const project = join(launch, 'project')
const STORE = join(launch, 'mercury-home')
const TWINS = join(launch, 'twins')
for (const dir of [project, STORE, TWINS]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_TMPDIR = join(launch, 'private-tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, cacheKeys } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

const PORT = 27065
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

type Rules = { allow?: string[]; deny?: string[]; mode?: string }
type Decision = { behavior: string; message?: string; suggestions?: Array<{ type?: string; rules?: Array<{ toolName: string; ruleContent: string }> }> }
const rulesOf = (rules: Rules = {}) =>
  ({
    ...getEmptyToolPermissionContext(),
    mode: rules.mode ?? 'default',
    alwaysAllowRules: rules.allow ? { userSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {},
  }) as never
const contextOf = (rules: Rules = {}) =>
  ({
    messages: [],
    options: { engineModel: 'claude-opus-4-8' },
    readFileState: createFileStateCacheWithSizeLimit(100),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({ toolPermissionContext: rulesOf(rules) }),
  }) as never
let turns = 0
const parent = (): unknown => ({ uuid: `00000000-0000-4000-8000-${String(turns).padStart(12, '0')}`, message: { id: `remote-write-${turns++}` } })
const read = async (path: string, context: unknown): Promise<string> => {
  try {
    const result = await FileReadTool.call({ file_path: path } as never, context as never, undefined, parent())
    return String(FileReadTool.mapToolResultToToolResultBlockParam(result.data as never, 'proof').content)
  } catch (error) {
    return `THROWN ${error instanceof Error ? error.message : String(error)}`
  }
}
const write = async (path: string, content: string, context: unknown = contextOf()): Promise<{ said: string; data: Record<string, unknown> | null }> => {
  try {
    const result = await FileWriteTool.call({ file_path: path, content } as never, context as never, undefined as never, parent() as never)
    return { said: String(FileWriteTool.mapToolResultToToolResultBlockParam(result.data as never, 'proof').content), data: result.data as unknown as Record<string, unknown> }
  } catch (error) {
    return { said: `THROWN ${error instanceof Error ? error.message : String(error)}`, data: null }
  }
}
const validated = async (path: string, rules: Rules = {}): Promise<{ result: boolean; message?: string }> => (await FileWriteTool.validateInput!({ file_path: path, content: 'x' } as never, contextOf(rules))) as { result: boolean; message?: string }
const decided = async (path: string, rules: Rules = {}): Promise<Decision> => (await FileWriteTool.checkPermissions({ file_path: path, content: 'x' } as never, contextOf(rules))) as unknown as Decision
const remote = (path: string): string => `ssh://box${path}`
const bytesAt = (path: string): Buffer => (existsSync(path) && statSync(path).isFile() ? readFileSync(path) : Buffer.from('<no file there>'))
const textAt = (path: string): string => bytesAt(path).toString('utf8')
const namesIn = (path: string): string[] => (existsSync(path) && statSync(path).isDirectory() ? readdirSync(path) : ['<no folder there>'])

async function writes(world: RemoteWorld): Promise<void> {
  const name = world.transport
  const dir = join(world.data, 'written')
  const twins = join(TWINS, name)
  mkdirSync(dir, { recursive: true })
  mkdirSync(twins, { recursive: true })

  section(`${name} · a new file`)
  const fresh = join(dir, 'made', 'here', 'notes.md')
  const freshTwin = join(twins, 'made', 'here', 'notes.md')
  const made = await write(remote(fresh), '# notes\n\nfirst line\n')
  const madeHere = await write(freshTwin, '# notes\n\nfirst line\n')
  check(`${name}: it is created on the remote machine, in folders that did not exist, and said so as here`, made.said === madeHere.said.replaceAll(freshTwin, remote(fresh)) && made.said.startsWith(`File created successfully at: ${remote(fresh)}`) && textAt(fresh) === '# notes\n\nfirst line\n' && made.data?.type === 'create' && made.data.filePath === remote(fresh), made.said)
  check(`${name}: and nothing was written on this disk under the spelling the path collapses to`, !existsSync(join(project, 'ssh:')) && namesIn(project).length === 0, namesIn(project).join(' '))
  check(`${name}: nothing is left beside it`, namesIn(join(dir, 'made', 'here')).join() === 'notes.md', namesIn(join(dir, 'made', 'here')).join())

  section(`${name} · a file that is there`)
  const file = join(dir, 'config.yml')
  const twin = join(twins, 'config.yml')
  for (const path of [file, twin]) {
    writeFileSync(path, 'name: app\nport: 80\n')
    chmodSync(path, 0o640)
  }
  const unread = await write(remote(file), 'name: app\nport: 8080\n')
  const unreadHere = await write(twin, 'name: app\nport: 8080\n')
  check(`${name}: unread, it is not overwritten, in the words a local file gets`, unread.said === unreadHere.said && unread.said.startsWith('THROWN ') && textAt(file) === 'name: app\nport: 80\n', unread.said)
  const context = contextOf()
  const contextHere = contextOf()
  await read(remote(file), context)
  await read(twin, contextHere)
  const updated = await write(remote(file), 'name: app\nport: 8080\n', context)
  const updatedHere = await write(twin, 'name: app\nport: 8080\n', contextHere)
  check(`${name}: read, it is replaced, and said so as here`, updated.said === updatedHere.said.replaceAll(twin, remote(file)) && updated.said.startsWith(`The file ${remote(file)} has been updated successfully.`) && textAt(file) === 'name: app\nport: 8080\n', updated.said)
  check(`${name}: its mode is kept`, (statSync(file).mode & 0o777) === 0o640, (statSync(file).mode & 0o777).toString(8))
  check(`${name}: the read ledger holds what was written, under the remote path`, cacheKeys((context as { readFileState: never }).readFileState).includes(remote(file)) && (context as { readFileState: { get(path: string): { content: string } | undefined } }).readFileState.get(remote(file))?.content === 'name: app\nport: 8080\n')
  const same = await write(remote(file), 'name: app\nport: 8080\n', context)
  const sameHere = await write(twin, 'name: app\nport: 8080\n', contextHere)
  check(`${name}: the same content again writes nothing, and says so as here`, same.said === sameHere.said.replaceAll(twin, remote(file)) && same.said.startsWith(`No changes were made to ${remote(file)}`), same.said)
  const again = await write(remote(file), 'name: app\nport: 9090\n', context)
  check(`${name}: a second write after the first needs no new read`, again.said.startsWith(`The file ${remote(file)} has been updated successfully.`) && textAt(file) === 'name: app\nport: 9090\n', again.said)
  for (const path of [file, twin]) {
    writeFileSync(path, 'name: app\nport: 1\nsomebody: else\n')
    const later = new Date(Date.now() + 20_000)
    utimesSync(path, later, later)
  }
  await write(twin, 'name: app\nport: 9090\n', contextHere)
  const stale = await write(remote(file), 'name: mine\n', context)
  const staleHere = await write(twin, 'name: mine\n', contextHere)
  check(`${name}: changed by someone else since it was read, it is not overwritten, in today's words`, stale.said === staleHere.said && stale.said.startsWith('THROWN ') && textAt(file) === 'name: app\nport: 1\nsomebody: else\n', `${stale.said} | ${staleHere.said}`)

  section(`${name} · line endings, a byte-order mark and UTF-16 are kept as a local write keeps them`)
  const shapes: Array<[string, Buffer, string]> = [
    ['crlf.txt', Buffer.from('one\r\ntwo\r\nthree\r\n'), 'one\ntwo changed\nthree\nfour\n'],
    ['bom.md', Buffer.from('\uFEFF# title\nbody\n'), '# title\nbody changed\n'],
    ['utf16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('uno\ndos\n', 'utf16le')]), 'uno\ndos\ntres\n'],
    ['open-end.txt', Buffer.from('no newline at the end'), 'still none\nat the end'],
  ]
  for (const [file, bytes, next] of shapes) {
    const there = join(dir, file)
    const here = join(twins, file)
    writeFileSync(there, bytes)
    writeFileSync(here, bytes)
    const far = contextOf()
    const near = contextOf()
    await read(remote(there), far)
    await read(here, near)
    const wrote = await write(remote(there), next, far)
    const wroteHere = await write(here, next, near)
    check(`${name}: ${file}: the bytes on the remote machine are the bytes a local write leaves`, bytesAt(there).equals(bytesAt(here)) && !bytesAt(there).equals(bytes) && wrote.said === wroteHere.said.replaceAll(here, remote(there)), `${wrote.said.slice(0, 200)} | ${bytesAt(there).toString('hex').slice(0, 80)} against ${bytesAt(here).toString('hex').slice(0, 80)}`)
  }

  section(`${name} · what a write will not replace`)
  mkdirSync(join(dir, 'a-folder'))
  const folder = await write(remote(join(dir, 'a-folder')), 'x')
  check(`${name}: a folder`, folder.said === `THROWN The path is a directory, not a file: ${remote(join(dir, 'a-folder'))}` && statSync(join(dir, 'a-folder')).isDirectory(), folder.said)
  const fifo = join(dir, 'a-pipe')
  spawnSync('mkfifo', [fifo])
  if (existsSync(fifo)) {
    const pipe = await write(remote(fifo), 'x')
    check(`${name}: a named pipe`, pipe.said === `THROWN Writing to ${remote(fifo)} is not allowed: it is a named pipe, not a file.`, pipe.said)
  }
  const real = join(dir, 'real.txt')
  writeFileSync(real, 'behind the link\n')
  symlinkSync(real, join(dir, 'link.txt'))
  const through = contextOf()
  await read(remote(join(dir, 'link.txt')), through)
  const linked = await write(remote(join(dir, 'link.txt')), 'written through\n', through)
  check(`${name}: a link is written through and stays a link`, linked.said.startsWith('The file ') && lstatSync(join(dir, 'link.txt')).isSymbolicLink() && textAt(real) === 'written through\n', linked.said)
  const entry = await validated(`${remote(join(dir, 'bundle.zip'))}:README.txt`)
  check(`${name}: an entry inside an archive on another machine`, entry.result === false && entry.message === `${remote(join(dir, 'bundle.zip'))}:README.txt names an entry inside an archive or a database on another machine, which Write and Edit do not change.`, String(entry.message))

  section(`${name} · the rules`)
  closeRemoteConnections()
  const connected = world.connectLines().length
  const asked = await decided(remote(join(dir, 'new.txt')))
  check(`${name}: with no rule the default mode asks, and offers all edits on the host for the session, with no connection made`, asked.behavior === 'ask' && JSON.stringify(asked.suggestions?.at(-1)?.rules) === JSON.stringify([{ toolName: 'Edit', ruleContent: 'ssh://box/**' }]) && world.connectLines().length === connected, JSON.stringify(asked))
  check(`${name}: a rule that allows edits on the host allows the write; one that allows reading does not`, (await decided(remote(join(dir, 'new.txt')), { allow: ['Edit(ssh://box/**)'] })).behavior === 'allow' && (await decided(remote(join(dir, 'new.txt')), { allow: ['Read(ssh://box/**)'] })).behavior === 'ask')
  const guarded = join(dir, 'guarded')
  mkdirSync(guarded)
  writeFileSync(join(guarded, 'keep.txt'), 'keep\n')
  symlinkSync(guarded, join(dir, 'side-door'))
  const deny = { allow: ['Edit(ssh://box/**)'], deny: [`Edit(ssh://box${guarded}/**)`] }
  const denied = await validated(remote(join(guarded, 'keep.txt')), deny)
  check(`${name}: a deny rule refuses the write by its own path before anything connects`, denied.result === false && denied.message === `Writing to ${remote(join(guarded, 'keep.txt'))} is denied by the rule Edit(ssh://box${guarded}/**) in your user settings.`, String(denied.message))
  const sneaked = await write(remote(join(dir, 'side-door', 'new.txt')), 'through a link\n', contextOf(deny))
  check(`${name}: and through a folder that is a link, once the remote machine has said where it leads: nothing is written`, sneaked.said.startsWith('THROWN Editing ') && sneaked.said.includes('is denied by the rule') && !existsSync(join(guarded, 'new.txt')), sneaked.said)
  const storeWrite = await decided(remote(join(STORE, '.credentials.json')), { mode: 'sovereign', allow: ['Edit(ssh://box/**)'] })
  const storeCall = await write(remote(join(STORE, 'runtime', 'current', 'mercury.mjs')), 'x', contextOf({ allow: ['Edit(ssh://box/**)'] }))
  check(`${name}: Mercury's own store and runtime on this machine are refused through the host`, storeWrite.behavior === 'deny' && storeCall.said.startsWith('THROWN Writing ') && storeCall.said.includes('is refused') && !existsSync(join(STORE, 'runtime')), `${storeWrite.message} | ${storeCall.said}`)
}

async function raced(world: RemoteWorld): Promise<void> {
  section('local · a file that changes between the last look and the write itself')
  const realSum = Bun.which('cksum')
  if (realSum === null) {
    console.log('  [SKIP] no cksum on this machine: a change at the moment of the write was not read')
    return
  }
  const armed = join(world.scratch, 'change-at-the-second-sum')
  writeFileSync(
    join(world.scratch, 'bin', 'cksum'),
    ['#!/bin/sh', `if [ -e '${armed}' ]; then n=$(cat '${armed}.count' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${armed}.count'; if [ "$n" -eq 2 ]; then printf 'someone else\\n' >> "$(cat '${armed}')"; fi; fi`, `exec '${realSum}' "$@"`, ''].join('\n'),
    { mode: 0o755 },
  )
  closeRemoteConnections()
  const file = join(world.data, 'raced.txt')
  writeFileSync(file, 'as it was read\n')
  const context = contextOf()
  await read(remote(file), context)
  writeFileSync(armed, file)
  const lost = await write(remote(file), 'mine\n', context)
  rmSync(armed)
  rmSync(`${armed}.count`, { force: true })
  rmSync(join(world.scratch, 'bin', 'cksum'))
  closeRemoteConnections()
  const twin = join(TWINS, 'raced.txt')
  writeFileSync(twin, 'as it was read\n')
  const contextHere = contextOf()
  await read(twin, contextHere)
  writeFileSync(twin, 'as it was read\nsomeone else\n')
  const later = new Date(Date.now() + 20_000)
  utimesSync(twin, later, later)
  const lostHere = await write(twin, 'mine\n', contextHere)
  check('the write is refused in the words of a file modified since it was read, and the other writer\'s line stands', lost.said === lostHere.said && lost.said.startsWith('THROWN ') && textAt(file) === 'as it was read\nsomeone else\n', `${lost.said} | ${lostHere.said} | ${JSON.stringify(textAt(file))}`)
  check('and nothing is left beside the file', namesIn(world.data).filter(entry => entry.includes('.mercury-')).length === 0, namesIn(world.data).join(' '))
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
      await writes(world)
      if (transport === 'local') await raced(world)
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

console.log(`\nremote write: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
