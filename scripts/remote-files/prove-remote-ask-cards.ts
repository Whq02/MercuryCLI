#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-ask-cards-')))
const project = join(scratch, 'project')
const outside = join(scratch, 'outside')
const collapsed = join(project, 'ssh:', 'web1', 'srv')
for (const dir of [collapsed, outside]) mkdirSync(dir, { recursive: true })
writeFileSync(join(collapsed, 'config.yml'), 'LOCAL FILE CONTENT\nport: 1\n## Checks\nlocal body\n')
writeFileSync(join(outside, 'secret.yml'), 'LOCAL SECRET\n')
symlinkSync(join(outside, 'secret.yml'), join(collapsed, 'link.yml'))
writeFileSync(join(project, 'a.txt'), 'alpha\nbeta\ngamma\n')
writeFileSync(join(outside, 'target.txt'), 'behind a local link\n')
symlinkSync(join(outside, 'target.txt'), join(project, 'link.txt'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const reactModule = (await import('react')) as unknown as { default?: typeof import('react') } & typeof import('react')
const React = reactModule.default ?? reactModule
const { default: stripAnsi } = await import('strip-ansi')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)
const { render } = await import('../../src/ink.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { FileWritePermissionRequest } = await import('../../src/components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.tsx')
const { FileEditPermissionRequest } = await import('../../src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx')
const { FilesystemPermissionRequest } = await import('../../src/components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')

const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 240 seconds')
  process.exit(1)
}, 240_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const REMOTE = 'ssh://web1/srv/config.yml'
const REMOTE_LINK = 'ssh://web1/srv/link.yml'
const ELSEWHERE = 'the path is on another machine'
const OUTSIDE = 'the path is outside the starting folder'
const NO = 'No, and tell Mercury what to do differently (esc)'
const NOTES = '# service\n\nname: app\nport: 1\nhost: a\n\n## Checks\n\n- typecheck\n\n## Notes\n\nend\n'

type Ledger = ReturnType<typeof createFileStateCacheWithSizeLimit>
type Context = { readFileState: Ledger }
const contextOf = (): Context =>
  ({
    messages: [],
    options: { engineModel: 'claude-opus-4-8' },
    readFileState: createFileStateCacheWithSizeLimit(100),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  }) as never
let turns = 0
const parent = (): unknown => ({ uuid: `00000000-0000-4000-8000-${String(turns).padStart(12, '0')}`, message: { id: `remote-ask-cards-${turns++}` } })

async function card(component: unknown, tool: unknown, input: Record<string, unknown>, reason: string, context: unknown = {}): Promise<string[]> {
  const stream = new PassThrough()
  stream.resume()
  Object.assign(stream, { columns: 100, rows: 60 })
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    unref() { return this },
    ref() { return this },
    pause() { return this },
    resume() { return this },
  })
  const toolUseConfirm = {
    tool,
    input,
    toolUseID: `toolu_${turns++}`,
    description: '',
    assistantMessage: { message: { id: 'remote-ask-cards' } },
    permissionResult: { behavior: 'ask', message: reason, decisionReason: { type: 'workingDir', reason } },
    onAllow() {},
    onReject() {},
    onAbort() {},
    recheckPermission() {},
    toolUseContext: context,
  }
  const element = React.createElement(component as never, { toolUseConfirm, onDone() {}, onReject() {}, toolUseContext: context, verbose: false } as never)
  const instance = await render(React.createElement(AppStateProvider as never, null, element), { stdout: stream as never, stdin: stdin as never, patchConsole: false })
  const rows = (): string[] => stripAnsi(instance.lastFrame()).split('\n').map(line => line.replace(/^[│\s]+|[│\s]+$/g, ''))
  for (const until = Date.now() + 5_000; Date.now() < until && !(rows().some(row => row.startsWith('Do you want to')) && !rows().includes('…')); ) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const settled = rows()
  instance.unmount()
  return settled
}
const writeCard = (path: string, content: string, reason = ELSEWHERE, context?: unknown): Promise<string[]> => card(FileWritePermissionRequest, FileWriteTool, { file_path: path, content }, reason, context)
const editCard = (input: Record<string, unknown>, reason = ELSEWHERE, context?: unknown): Promise<string[]> => card(FileEditPermissionRequest, FileEditTool, input, reason, context)
const readCard = (path: string): Promise<string[]> => card(FilesystemPermissionRequest, FileReadTool, { file_path: path }, ELSEWHERE)
const subtitle = (rows: string[]): string => rows[rows.findIndex(row => row.startsWith('⦿ ')) + 1] ?? ''
const body = (rows: string[], reason: string): string[] => {
  const start = rows.findIndex(row => row.startsWith('⦿ ')) + 1
  const end = rows.findIndex((row, index) => index > start && row === reason)
  return start === 0 || end === -1 ? ['<the card has no title or no such reason>', ...rows] : rows.slice(start + 1, end).filter(row => !/^[╌╭╮╰╯─]+$/.test(row))
}
const local = (rows: string[]): string[] => rows.filter(row => /LOCAL|local body|Symlink target|via a symlink|This operation will modify/.test(row))
const same = (rows: string[], wanted: string[]): boolean => JSON.stringify(rows) === JSON.stringify(wanted)

async function ownWords(): Promise<void> {
  section('Write on another machine, unread: the card says what is written and where, and reads nothing here')
  const write = await writeCard(REMOTE, 'name: app\nport: 8080\n')
  check('its title is Edit file: whether the file is there is not known before the machine is asked', write.includes('⦿ Edit file') && !write.some(row => /Overwrite file|Create file/.test(row)), write.join(' | '))
  check('it names the path as it was written', subtitle(write) === REMOTE, subtitle(write))
  const far = 'ssh://deploy@web1.internal.example.com:2222/srv/app/releases/2026-11-13/shared/config/environments/production.yml'
  const long = await writeCard(far, 'x\n')
  check('a path longer than the card keeps its machine and its file name, and loses its middle', subtitle(long).startsWith('ssh://deploy@web1.internal.example.com:2222/') && subtitle(long).endsWith('/production.yml') && subtitle(long).includes('…'), subtitle(long))
  check('it shows the content to be written, and only that', same(body(write, ELSEWHERE), ['1  name: app', '2  port: 8080']), JSON.stringify(body(write, ELSEWHERE)))
  check('no line of the local file that stands at the spelling the two slashes collapse to is drawn', local(write).length === 0, local(write).join(' | '))
  check('it asks whether to proceed', write.includes('Do you want to proceed?') && !write.some(row => /Do you want to (overwrite|create)/.test(row)), write.join(' | '))
  check('and offers yes, all edits on that host for the session, and no', same(write.filter(row => /^(❯ )?\d\. /.test(row)).map(row => row.replace(/^❯ /, '')), ['1. Yes', '2. Yes, allow all edits on web1 for this session (shift+tab)', `3. ${NO}`]), write.filter(row => /\d\. /.test(row)).join(' | '))
  const writeLink = await writeCard(REMOTE_LINK, 'name: app\n')
  check('a local link at the collapsed spelling is not followed: no line about a symlink, nothing of what it leads to', local(writeLink).length === 0 && same(body(writeLink, ELSEWHERE), ['1  name: app']), `${local(writeLink).join(' | ')} ${JSON.stringify(body(writeLink, ELSEWHERE))}`)

  section('Edit on another machine, unread: the edit\'s own old and new text')
  const swap = await editCard({ file_path: REMOTE, old_string: 'port: 1\nhost: a', new_string: 'port: 2\nhost: a' })
  check('old_string and new_string: the path as written, the lines that change, today\'s question', swap.includes('⦿ Edit file') && subtitle(swap) === REMOTE && same(body(swap, ELSEWHERE), ['config.yml', '1 -port: 1', '1 +port: 2', '2  host: a']) && swap.includes('Do you want to make this edit to config.yml?'), swap.join(' | '))
  check('nothing of the local file is drawn around it', local(swap).length === 0, local(swap).join(' | '))
  const gone = await editCard({ file_path: REMOTE, old_string: 'port: 1\n', new_string: '' })
  check('a deletion shows the lines that go', same(body(gone, ELSEWHERE), ['config.yml', '1 -port: 1']), JSON.stringify(body(gone, ELSEWHERE)))
  const hunks = await editCard({ file_path: REMOTE, hunks: [{ lines: '2', replace: 'port: 2\n' }, { lines: '3', insert: 'after', replace: '- added' }, { lines: '4', insert: 'before', replace: 'before the body\n' }] })
  check('hunks: the lines each one names and what goes in, an insertion beside its anchor line and not in place of it', same(body(hunks, ELSEWHERE), ['config.yml', '1 -lines 2', '1 +port: 2', '2  lines 3', '3 +- added', '4 +before the body', '5  lines 4']), JSON.stringify(body(hunks, ELSEWHERE)))
  check('and the local file\'s own lines 2 to 4 are not planned against', local(hunks).length === 0 && !hunks.some(row => /port: 1|## Checks/.test(row)), hunks.join(' | '))
  const appended = await editCard({ file_path: REMOTE, append: 'last: line\nand: another' })
  check('append: the lines added', same(body(appended, ELSEWHERE), ['config.yml', '1 +last: line', '2 +and: another']) && local(appended).length === 0, JSON.stringify(body(appended, ELSEWHERE)))
  const sectionAppend = await editCard({ file_path: REMOTE, section: '## Checks', append: '- one more check\n' })
  check('a section and an append: the heading it names, and the lines added under it', same(body(sectionAppend, ELSEWHERE), ['config.yml', '1  ## Checks', '2 +- one more check']) && local(sectionAppend).length === 0, JSON.stringify(body(sectionAppend, ELSEWHERE)))
  const sectionNew = await editCard({ file_path: REMOTE, section: '## Checks', new_string: '## Checks\n\n- typecheck\n- build\n' })
  check('a section and its new text: the heading and the text that takes its place, not the local file\'s section', same(body(sectionNew, ELSEWHERE), ['config.yml', '1  ## Checks', '2 +', '3 +- typecheck', '4 +- build']) && local(sectionNew).length === 0, JSON.stringify(body(sectionNew, ELSEWHERE)))
  const editLink = await editCard({ file_path: REMOTE_LINK, old_string: 'a', new_string: 'b' })
  check('a local link at the collapsed spelling is not followed', local(editLink).length === 0 && subtitle(editLink) === REMOTE_LINK, local(editLink).join(' | '))
  check('each edit card offers all edits on that host for the session', [swap, hunks, appended, sectionNew].every(rows => rows.includes('2. Yes, allow all edits on web1 for this session (shift+tab)')))

  section('Read on another machine')
  const read = await readCard(REMOTE_LINK)
  check('the card names the read as written and offers the host', read.includes('⦿ Read file') && read.includes(`Read(${REMOTE_LINK})`) && read.includes('2. Yes, allow reading from web1 for this session') && read.includes('Do you want to proceed?'), read.join(' | '))
  check('a local link at the collapsed spelling is not followed', local(read).length === 0, local(read).join(' | '))
}

async function lastRead(world: RemoteWorld): Promise<void> {
  const file = join(world.data, 'notes.md')
  const path = `ssh://box${file}`
  writeFileSync(file, NOTES)
  mkdirSync(join(project, 'ssh:', 'box', dirname(file).slice(1)), { recursive: true })
  writeFileSync(join(project, 'ssh:', 'box', file.slice(1)), 'LOCAL FILE CONTENT\nport: 1\n## Checks\nlocal body\n')
  const read = async (input: Record<string, unknown>, context: Context): Promise<void> => {
    await FileReadTool.call({ file_path: path, ...input } as never, context as never, undefined, parent() as never)
  }
  const shapes: Array<[string, Record<string, unknown>, string[], string[]]> = [
    ['old_string and new_string', { old_string: 'port: 1', new_string: 'port: 2' }, ['notes.md', '1  # service', '2', '3  name: app', '4 -port: 1', '4 +port: 2', '5  host: a', '6', '7  ## Checks'], ['notes.md', '1 -port: 1', '1 +port: 2']],
    [
      'hunks',
      { hunks: [{ lines: '4', replace: 'port: 2\n' }, { lines: '9', insert: 'after', replace: '- build' }] },
      ['notes.md', '1  # service', '2', '3  name: app', '4 -port: 1', '4 +port: 2', '5  host: a', '6', '7  ## Checks', '8', '9  - typecheck', '10 +- build', '11', '12  ## Notes', '13'],
      ['notes.md', '1 -lines 4', '1 +port: 2', '2  lines 9', '3 +- build'],
    ],
    ['append', { append: 'last: line' }, ['notes.md', '11  ## Notes', '12', '13  end', '14 +last: line'], ['notes.md', '1 +last: line']],
    ['a section and an append', { section: '## Checks', append: '- build\n' }, ['notes.md', '7  ## Checks', '8', '9  - typecheck', '10 +- build', '11', '12  ## Notes', '13'], ['notes.md', '1  ## Checks', '2 +- build']],
    [
      'a section and its new text',
      { section: '## Checks', new_string: '## Checks\n\n- build only\n' },
      ['notes.md', '6', '7  ## Checks', '8', '9 -- typecheck', '10 -', '9 +- build only', '10  ## Notes', '11', '12  end'],
      ['notes.md', '1  ## Checks', '2 +', '3 +- build only'],
    ],
  ]

  section('Edit on another machine, the file read whole in this session: the change is drawn against what was read')
  const whole = contextOf()
  await read({}, whole)
  for (const [name, input, wanted] of shapes) {
    const rows = await editCard({ file_path: path, ...input }, ELSEWHERE, whole)
    check(`${name}: the lines that go out and the lines that go in, at their own numbers`, same(body(rows, ELSEWHERE), wanted) && local(rows).length === 0, JSON.stringify(body(rows, ELSEWHERE)))
    if (name === 'hunks') check('the card names the machine and the file, whatever the length of the path', subtitle(rows).startsWith('ssh://box/') && subtitle(rows).endsWith('/notes.md'), subtitle(rows))
  }
  const rewritten = await writeCard(path, NOTES.replace('port: 1', 'port: 8080'), ELSEWHERE, whole)
  check('Write: the same, and the title and the question stay as they are for a file on another machine', same(body(rewritten, ELSEWHERE), ['1  # service', '2', '3  name: app', '4 -port: 1', '4 +port: 8080', '5  host: a', '6', '7  ## Checks']) && rewritten.includes('⦿ Edit file') && rewritten.includes('Do you want to proceed?') && local(rewritten).length === 0, JSON.stringify(body(rewritten, ELSEWHERE)))

  const windows = join(world.data, 'windows.txt')
  writeFileSync(windows, '\uFEFFone\r\ntwo\r\nthree\r\n')
  const marked = contextOf()
  await FileReadTool.call({ file_path: `ssh://box${windows}` } as never, marked as never, undefined, parent() as never)
  const crlf = await editCard({ file_path: `ssh://box${windows}`, old_string: 'two', new_string: 'TWO' }, ELSEWHERE, marked)
  check('a file with a byte-order mark and CRLF endings, read whole, is drawn the same way', same(body(crlf, ELSEWHERE), ['windows.txt', '1  one', '2 -two', '2 +TWO', '3  three']), JSON.stringify(body(crlf, ELSEWHERE)))

  section('Only a page of it read, or more lines than one read returns: the edit\'s own words again')
  const paged = contextOf()
  await read({ offset: 3, limit: 4 }, paged)
  for (const [name, input, , wanted] of shapes) {
    const rows = await editCard({ file_path: path, ...input }, ELSEWHERE, paged)
    check(`${name}, after a read of lines 3 to 6`, same(body(rows, ELSEWHERE), wanted) && local(rows).length === 0, JSON.stringify(body(rows, ELSEWHERE)))
  }
  const pagedWrite = await writeCard(path, 'all new\n', ELSEWHERE, paged)
  check('Write, after a read of lines 3 to 6: the content to be written', same(body(pagedWrite, ELSEWHERE), ['1  all new']), JSON.stringify(body(pagedWrite, ELSEWHERE)))
  const long = join(world.data, 'long.txt')
  const longPath = `ssh://box${long}`
  writeFileSync(long, Array.from({ length: 2600 }, (_, index) => `row ${index + 1}`).join('\n') + '\n')
  const cut = contextOf()
  await FileReadTool.call({ file_path: longPath } as never, cut as never, undefined, parent() as never)
  const entry = cut.readFileState.get(longPath)
  check('a read with no offset and no limit of a file longer than one read returns leaves an entry that looks whole and is not', entry !== undefined && (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined && entry.content.split('\n').length < 2600, JSON.stringify({ offset: entry?.offset, limit: entry?.limit, lines: entry?.content.split('\n').length }))
  const cutAppend = await editCard({ file_path: longPath, append: 'row at the end' }, ELSEWHERE, cut)
  check('and the card does not take it for the file: an append is drawn as the edit\'s own line, not after the last line that was read', same(body(cutAppend, ELSEWHERE), ['long.txt', '1 +row at the end']), JSON.stringify(body(cutAppend, ELSEWHERE)))

  section('What else leaves the card on the edit\'s own words, and what does not')
  const stale = await editCard({ file_path: path, old_string: 'a line that is not in the file', new_string: 'x' }, ELSEWHERE, whole)
  check('an old_string that is not in what was read', same(body(stale, ELSEWHERE), ['notes.md', '1 -a line that is not in the file', '1 +x']), JSON.stringify(body(stale, ELSEWHERE)))
  const rebuilt = contextOf()
  rebuilt.readFileState.set(path, { ...whole.readFileState.get(path)! })
  const copied = await editCard({ file_path: path, old_string: 'port: 1', new_string: 'port: 2' }, ELSEWHERE, rebuilt)
  check('an entry that was copied into another ledger and not read there', same(body(copied, ELSEWHERE), ['notes.md', '1 -port: 1', '1 +port: 2']), JSON.stringify(body(copied, ELSEWHERE)))
  const written = contextOf()
  await read({}, written)
  await FileWriteTool.call({ file_path: path, content: NOTES.replace('port: 1', 'port: 7') } as never, written as never, undefined as never, parent() as never)
  const afterWrite = await editCard({ file_path: path, old_string: 'port: 7', new_string: 'port: 8' }, ELSEWHERE, written)
  check('after a write through the tool the change is drawn against what was written', same(body(afterWrite, ELSEWHERE), ['notes.md', '1  # service', '2', '3  name: app', '4 -port: 7', '4 +port: 8', '5  host: a', '6', '7  ## Checks']), JSON.stringify(body(afterWrite, ELSEWHERE)))
}

async function here(): Promise<void> {
  section('A file on this machine is asked about as it was')
  const over = await writeCard(join(project, 'a.txt'), 'alpha\nbeta CHANGED\ngamma\n', OUTSIDE)
  check('a write over a file that is there', over.includes('⦿ Overwrite file') && same(body(over, OUTSIDE), ['1  alpha', '2 -beta', '2 +beta CHANGED', '3  gamma']) && over.includes('Do you want to overwrite a.txt?') && over.includes('2. Yes, allow all edits for this session (shift+tab)'), over.join(' | '))
  const fresh = await writeCard(join(project, 'new.txt'), 'one\ntwo\n', OUTSIDE)
  check('a write of a new file', fresh.includes('⦿ Create file') && same(body(fresh, OUTSIDE), ['1  one', '2  two']) && fresh.includes('Do you want to create new.txt?'), fresh.join(' | '))
  const edited = await editCard({ file_path: join(project, 'a.txt'), old_string: 'beta', new_string: 'beta CHANGED' }, OUTSIDE)
  check('an edit, drawn against the file with its neighbours', edited.includes('⦿ Edit file') && same(body(edited, OUTSIDE), ['a.txt', '1  alpha', '2 -beta', '2 +beta CHANGED', '3  gamma']) && edited.includes('Do you want to make this edit to a.txt?'), edited.join(' | '))
  const planned = await editCard({ file_path: join(project, 'a.txt'), hunks: [{ lines: '2', replace: 'BETA' }] }, OUTSIDE)
  check('an edit by hunks, planned against the file', same(body(planned, OUTSIDE), ['a.txt', '1  alpha', '2 -beta', '2 +BETA', '3  gamma']), JSON.stringify(body(planned, OUTSIDE)))
  const linked = await writeCard(join(project, 'link.txt'), 'x\n', OUTSIDE)
  check('a local link is still named with where it leads', linked.join(' ').includes(`This operation will modify ${join(outside, 'target.txt')}`) && linked.join(' ').includes('via a symlink'), linked.join(' | '))
  const oneSlash = await writeCard('ssh:/web1/srv/config.yml', 'mine\n', OUTSIDE)
  check('a relative path under a folder named ssh: with one slash is a file here, drawn against what it holds', oneSlash.includes('⦿ Overwrite file') && oneSlash.includes('ssh:/web1/srv/config.yml') && oneSlash.includes('1 -LOCAL FILE CONTENT') && oneSlash.includes('Do you want to overwrite config.yml?'), oneSlash.join(' | '))
}

try {
  await ownWords()
  const unavailable = localTransportUnavailable()
  if (unavailable !== null) console.log(`  [SKIP] the local transport: ${unavailable}`)
  else {
    const world = await remoteWorld('local', 0, { clientHome: HOME })
    const leave = enterWorld(world)
    try {
      await lastRead(world)
    } finally {
      closeRemoteConnections()
      leave()
      await world.stop()
    }
  }
  await here()
} finally {
  process.chdir(tmpdir())
  removeScratch(scratch)
}

console.log(`\nremote ask cards: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
