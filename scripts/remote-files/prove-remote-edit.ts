#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-edit-')))
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
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
const remoteTarget = (await import('../../src/services/remoteFiles/target.ts')) as { remoteLastRead?: (ledger: unknown, path: string) => string | null }
const rewindScreen = (await import('../../src/components/MessageSelector.tsx')) as { writtenElsewhereLine?: (messages: never, from: string) => string | null }
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

const PORT = 27066
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
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Rules = { allow?: string[]; deny?: string[]; mode?: string }
type Decision = { behavior: string; message?: string; suggestions?: Array<{ type?: string; rules?: Array<{ toolName: string; ruleContent: string }> }> }
type Context = { readFileState: { get(path: string): { content: string } | undefined }; nestedMemoryAttachmentTriggers: Set<string>; dynamicSkillDirTriggers: Set<string>; checkpointed: string[] }
type Input = Record<string, unknown> & { file_path: string }
type Said = { said: string; data: Record<string, unknown> | null }
const rulesOf = (rules: Rules = {}) =>
  ({
    ...getEmptyToolPermissionContext(),
    mode: rules.mode ?? 'default',
    alwaysAllowRules: rules.allow ? { userSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { userSettings: rules.deny } : {},
  }) as never
const contextOf = (rules: Rules = {}): Context => {
  const checkpointed: string[] = []
  return {
    messages: [],
    options: { engineModel: 'claude-opus-4-8' },
    readFileState: createFileStateCacheWithSizeLimit(100),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    updateFileHistoryState: () => {
      checkpointed.push('a checkpoint was taken')
    },
    getAppState: () => ({ toolPermissionContext: rulesOf(rules) }),
    checkpointed,
  } as never
}
const thrown = (error: unknown): string => `THROWN ${error instanceof Error ? error.message : String(error)}`
let turns = 0
const parent = (): unknown => ({ uuid: `00000000-0000-4000-8000-${String(turns).padStart(12, '0')}`, message: { id: `remote-edit-${turns++}` } })
const read = async (path: string, context: Context, more: Record<string, unknown> = {}): Promise<string> => {
  try {
    const result = await FileReadTool.call({ file_path: path, ...more } as never, context as never, undefined, parent())
    return String(FileReadTool.mapToolResultToToolResultBlockParam(result.data as never, 'proof').content)
  } catch (error) {
    return thrown(error)
  }
}
const edit = async (input: Input, context: Context = contextOf()): Promise<Said> => {
  try {
    const verdict = (await FileEditTool.validateInput!(input as never, context as never)) as { result: boolean; message?: string }
    if (verdict.result === false) return { said: `THROWN ${verdict.message}`, data: null }
    const result = await FileEditTool.call(input as never, context as never, undefined as never, parent() as never)
    return { said: String(FileEditTool.mapToolResultToToolResultBlockParam(result.data as never, 'proof').content), data: result.data as unknown as Record<string, unknown> }
  } catch (error) {
    return { said: thrown(error), data: null }
  }
}
const validated = async (input: Input, rules: Rules = {}, tool: { validateInput?: (input: never, context: never) => Promise<unknown> } = FileEditTool): Promise<{ result: boolean; message?: string }> => {
  try {
    return (await tool.validateInput!(input as never, contextOf(rules) as never)) as { result: boolean; message?: string }
  } catch (error) {
    return { result: false, message: thrown(error) }
  }
}
const decided = async (path: string, rules: Rules = {}): Promise<Decision> => {
  try {
    return (await FileEditTool.checkPermissions({ file_path: path, old_string: 'a', new_string: 'b' } as never, contextOf(rules) as never)) as unknown as Decision
  } catch (error) {
    return { behavior: 'thrown', message: thrown(error) }
  }
}
const remote = (path: string): string => `ssh://box${path}`
const bytesAt = (path: string): Buffer => (existsSync(path) && statSync(path).isFile() ? readFileSync(path) : Buffer.from('<no file there>'))
const textAt = (path: string): string => bytesAt(path).toString('utf8')
const namesIn = (path: string): string[] => (existsSync(path) && statSync(path).isDirectory() ? readdirSync(path) : ['<no folder there>'])
const anchorOf = (answer: string): string => /\(anchor: ((?:fa|ra):[^)\s]+)\)/.exec(answer)?.[1] ?? '<the read gave no anchor>'

const SERVICE = '# service\n\nname: app\nport: 80\nhost: a\nport: 80\n\n## Checks\n\n- typecheck\n\n## Notes\n\nend\n'

async function pair(
  name: string,
  dir: string,
  twins: string,
  file: string,
  bytes: Buffer | string,
  prepare: 'whole' | 'unread' | { offset: number; limit: number },
  input: (anchor: string) => Record<string, unknown>,
): Promise<{ there: Said; here: Said; same: boolean; bytesSame: boolean; path: string; context: Context }> {
  const far = join(dir, file)
  const near = join(twins, file)
  for (const path of [far, near]) {
    writeFileSync(path, bytes)
    const at = new Date(1_700_000_000_000)
    utimesSync(path, at, at)
  }
  const context = contextOf()
  const contextHere = contextOf()
  let anchor = ''
  if (prepare !== 'unread') {
    const more = prepare === 'whole' ? {} : prepare
    const answer = await read(remote(far), context, more)
    const answerHere = await read(near, contextHere, more)
    anchor = anchorOf(answer)
    if (anchor !== anchorOf(answerHere)) console.log(`  [info] ${name}: ${file}: the two reads gave different anchors: ${anchor} and ${anchorOf(answerHere)}`)
  }
  const there = await edit({ file_path: remote(far), ...input(anchor) }, context)
  const here = await edit({ file_path: near, ...input(anchor) }, contextHere)
  return { there, here, same: there.said === here.said.replaceAll(near, remote(far)), bytesSame: bytesAt(far).equals(bytesAt(near)), path: remote(far), context }
}

async function edits(world: RemoteWorld): Promise<void> {
  const name = world.transport
  const dir = join(world.data, 'edited')
  const twins = join(TWINS, name)
  mkdirSync(dir, { recursive: true })
  mkdirSync(twins, { recursive: true })
  const tell = (run: { there: Said; here: Said }): string => `remote ${JSON.stringify(run.there.said.slice(0, 380))} local ${JSON.stringify(run.here.said.slice(0, 380))}`

  section(`${name} · each way of editing answers and leaves what the same edit of the same file here does`)
  const exact = await pair(name, dir, twins, 'exact.yml', SERVICE, 'whole', () => ({ old_string: 'host: a', new_string: 'host: b' }))
  check(`${name}: old_string and new_string`, exact.same && exact.bytesSame && exact.there.said.startsWith(`The file ${exact.path} has been updated`) && textAt(join(dir, 'exact.yml')).includes('host: b'), tell(exact))
  check(`${name}: the answer's data names the file by its remote path`, exact.there.data?.filePath === exact.path, String(exact.there.data?.filePath))
  check(`${name}: the read ledger holds the file as it now stands, under the remote path, and it is known to be the whole of it`, exact.context.readFileState.get(exact.path)?.content === SERVICE.replace('host: a', 'host: b') && remoteTarget.remoteLastRead?.(exact.context.readFileState, exact.path) === SERVICE.replace('host: a', 'host: b'), String(exact.context.readFileState.get(exact.path)?.content).slice(0, 120))
  check(`${name}: nothing was checkpointed, attached or discovered on this disk for it`, exact.context.checkpointed.length === 0 && exact.context.nestedMemoryAttachmentTriggers.size === 0 && exact.context.dynamicSkillDirTriggers.size === 0, `${exact.context.checkpointed.length} ${[...exact.context.nestedMemoryAttachmentTriggers].join()} ${[...exact.context.dynamicSkillDirTriggers].join()}`)
  const second = await edit({ file_path: exact.path, old_string: 'name: app', new_string: 'name: service' }, exact.context)
  check(`${name}: a second edit after the first needs no new read`, second.said.startsWith(`The file ${exact.path} has been updated`) && textAt(join(dir, 'exact.yml')).includes('name: service'), second.said)
  const span = [exact.there.data, second.data].map((toolUseResult, index) => ({ type: 'user', uuid: `span-${index}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${index}`, content: 'ok' }] }, toolUseResult }))
  const stays = rewindScreen.writtenElsewhereLine === undefined ? '<the rewind screen reads no such thing>' : rewindScreen.writtenElsewhereLine(span as never, 'before-the-span')
  check(`${name}: what the edits answered is what the rewind page reads to say the file stays as written`, stays === `Stays as written on another machine: ${exact.path}.`, String(stays))
  const all = await pair(name, dir, twins, 'all.yml', SERVICE, 'whole', () => ({ old_string: 'port: 80', new_string: 'port: 8080', replace_all: true }))
  check(`${name}: replace_all`, all.same && all.bytesSame && textAt(join(dir, 'all.yml')).split('port: 8080').length === 3, tell(all))
  const hunks = await pair(name, dir, twins, 'hunks.yml', SERVICE, 'whole', anchor => ({ expected_anchor: anchor, hunks: [{ lines: '4', replace: 'port: 443' }, { lines: '10', insert: 'after', replace: '- build' }, { lines: '14', replace: '' }] }))
  check(`${name}: hunks against the anchor the Read of the remote file gave`, hunks.same && hunks.bytesSame && textAt(join(dir, 'hunks.yml')) === SERVICE.replace('port: 80\nhost', 'port: 443\nhost').replace('- typecheck\n', '- typecheck\n- build\n').replace('\nend\n', '\n'), tell(hunks))
  const appended = await pair(name, dir, twins, 'append.yml', SERVICE, 'unread', () => ({ append: 'last: line' }))
  check(`${name}: append`, appended.same && appended.bytesSame && textAt(join(dir, 'append.yml')) === `${SERVICE}last: line\n`, tell(appended))
  const sectionNew = await pair(name, dir, twins, 'section.md', SERVICE, 'whole', () => ({ section: '## Checks', new_string: '## Checks\n\n- build only\n' }))
  check(`${name}: a section and its new text`, sectionNew.same && sectionNew.bytesSame && textAt(join(dir, 'section.md')).includes('- build only') && !textAt(join(dir, 'section.md')).includes('- typecheck'), tell(sectionNew))
  const sectionAppend = await pair(name, dir, twins, 'section-append.md', SERVICE, 'whole', () => ({ section: '## Checks', append: '- lint' }))
  check(`${name}: a section and an append`, sectionAppend.same && sectionAppend.bytesSame && textAt(join(dir, 'section-append.md')).includes('- typecheck\n- lint\n'), tell(sectionAppend))
  const removed = await pair(name, dir, twins, 'removed.yml', SERVICE, 'whole', () => ({ old_string: 'host: a\n', new_string: '' }))
  check(`${name}: an edit that removes lines`, removed.same && removed.bytesSame && !textAt(join(dir, 'removed.yml')).includes('host: a'), tell(removed))
  const unchanged = await pair(name, dir, twins, 'unchanged.yml', SERVICE, 'whole', anchor => ({ expected_anchor: anchor, hunks: [{ lines: '5', replace: 'host: a' }] }))
  check(`${name}: an edit that changes nothing writes nothing and says so`, unchanged.same && unchanged.bytesSame && unchanged.there.said.startsWith(`No changes made to ${unchanged.path}`), tell(unchanged))

  section(`${name} · line endings, a byte-order mark and UTF-16 are kept as a local edit keeps them`)
  const shapes: Array<[string, Buffer]> = [
    ['crlf.txt', Buffer.from('one\r\ntwo\r\nthree\r\n')],
    ['bom.md', Buffer.from('\uFEFFone\ntwo\nthree\n')],
    ['utf16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('one\ntwo\nthree\n', 'utf16le')])],
    ['open-end.txt', Buffer.from('one\ntwo\nthree')],
    ['mixed.txt', Buffer.from('one\r\ntwo\nthree\r\n')],
  ]
  for (const [file, bytes] of shapes) {
    const run = await pair(name, dir, twins, file, bytes, 'whole', () => ({ old_string: 'two', new_string: 'TWO\nand a half' }))
    check(`${name}: ${file}: the bytes on the remote machine are the bytes a local edit leaves`, run.same && run.bytesSame && !bytesAt(join(dir, file)).equals(bytes), `${tell(run)} | ${bytesAt(join(dir, file)).toString('hex').slice(0, 90)} against ${bytesAt(join(twins, file)).toString('hex').slice(0, 90)}`)
  }
  for (const path of [join(dir, 'mode.sh'), join(twins, 'mode.sh')]) {
    writeFileSync(path, '#!/bin/sh\necho one\n')
    chmodSync(path, 0o750)
  }
  const moded = contextOf()
  await read(remote(join(dir, 'mode.sh')), moded)
  await edit({ file_path: remote(join(dir, 'mode.sh')), old_string: 'echo one', new_string: 'echo two' }, moded)
  check(`${name}: the file's mode is kept`, (statSync(join(dir, 'mode.sh')).mode & 0o777) === 0o750 && textAt(join(dir, 'mode.sh')).includes('echo two'), (statSync(join(dir, 'mode.sh')).mode & 0o777).toString(8))
  const real = join(dir, 'real.txt')
  writeFileSync(real, 'behind the link\n')
  symlinkSync(real, join(dir, 'link.txt'))
  const through = contextOf()
  await read(remote(join(dir, 'link.txt')), through)
  const linked = await edit({ file_path: remote(join(dir, 'link.txt')), old_string: 'behind', new_string: 'through' }, through)
  check(`${name}: a link is edited through and stays a link`, linked.said.startsWith('The file ') && lstatSync(join(dir, 'link.txt')).isSymbolicLink() && textAt(real) === 'through the link\n', linked.said)
  check(`${name}: nothing is left beside the files`, namesIn(dir).filter(entry => entry.includes('.mercury-')).length === 0, namesIn(dir).join(' '))

  section(`${name} · a file that is made by the edit`)
  const made = await edit({ file_path: remote(join(dir, 'made', 'here', 'new.ts')), old_string: '', new_string: 'export const one = 1\n' })
  const madeHere = await edit({ file_path: join(twins, 'made', 'here', 'new.ts'), old_string: '', new_string: 'export const one = 1\n' })
  check(`${name}: an empty old_string creates the file on the remote machine, in folders that did not exist`, made.said === madeHere.said.replaceAll(join(twins, 'made', 'here', 'new.ts'), remote(join(dir, 'made', 'here', 'new.ts'))) && textAt(join(dir, 'made', 'here', 'new.ts')) === 'export const one = 1\n', `${made.said.slice(0, 300)} | ${madeHere.said.slice(0, 300)}`)
  const logged = await edit({ file_path: remote(join(dir, 'made', 'log.txt')), append: 'a line' })
  const loggedHere = await edit({ file_path: join(twins, 'made', 'log.txt'), append: 'a line' })
  check(`${name}: an append to a file that is not there creates it`, logged.said === loggedHere.said.replaceAll(join(twins, 'made', 'log.txt'), remote(join(dir, 'made', 'log.txt'))) && textAt(join(dir, 'made', 'log.txt')) === 'a line\n', `${logged.said.slice(0, 300)} | ${loggedHere.said.slice(0, 300)}`)
  check(`${name}: and nothing was written on this disk under the spelling the path collapses to`, !existsSync(join(project, 'ssh:')) && namesIn(project).length === 0, namesIn(project).join(' '))

  section(`${name} · what an edit is refused for, in the words a local file gets`)
  const unread = await pair(name, dir, twins, 'unread.yml', SERVICE, 'unread', () => ({ old_string: 'host: a', new_string: 'host: b' }))
  check(`${name}: a file that was not read`, unread.same && unread.bytesSame && unread.there.said.startsWith('THROWN ') && textAt(join(dir, 'unread.yml')) === SERVICE, tell(unread))
  const inPage = await pair(name, dir, twins, 'in-page.yml', SERVICE, { offset: 3, limit: 4 }, () => ({ old_string: 'host: a', new_string: 'host: b' }))
  check(`${name}: lines 3 to 6 read, an edit inside them goes through`, inPage.same && inPage.bytesSame && inPage.there.said.startsWith('The file '), tell(inPage))
  const outOfPage = await pair(name, dir, twins, 'out-of-page.yml', SERVICE, { offset: 3, limit: 2 }, () => ({ old_string: '- typecheck', new_string: '- build' }))
  check(`${name}: lines 3 and 4 read, an edit of line 10 is answered as here`, outOfPage.same && outOfPage.bytesSame, tell(outOfPage))
  const absent = await pair(name, dir, twins, 'absent.yml', SERVICE, 'whole', () => ({ old_string: 'no such line anywhere', new_string: 'x' }))
  check(`${name}: an old_string that is not in the file`, absent.same && absent.bytesSame && absent.there.said.startsWith('THROWN ') && textAt(join(dir, 'absent.yml')) === SERVICE, tell(absent))
  const twice = await pair(name, dir, twins, 'twice.yml', SERVICE, 'whole', () => ({ old_string: 'port: 80', new_string: 'port: 1' }))
  check(`${name}: an old_string that is there twice, without replace_all`, twice.same && twice.bytesSame && twice.there.said.startsWith('THROWN ') && textAt(join(dir, 'twice.yml')) === SERVICE, tell(twice))
  const identical = await pair(name, dir, twins, 'identical.yml', SERVICE, 'whole', () => ({ old_string: 'host: a', new_string: 'host: a' }))
  check(`${name}: an old_string equal to the new one`, identical.same && identical.there.said.startsWith('THROWN '), tell(identical))
  const staleAnchor = await pair(name, dir, twins, 'stale-anchor.yml', SERVICE, 'whole', () => ({ expected_anchor: 'fa:000000000000', hunks: [{ lines: '4', replace: 'port: 443' }] }))
  check(`${name}: hunks against an anchor that is not the file's`, staleAnchor.same && staleAnchor.bytesSame && staleAnchor.there.said.startsWith('THROWN '), tell(staleAnchor))
  const noSection = await pair(name, dir, twins, 'no-section.md', SERVICE, 'whole', () => ({ section: '## Nothing', new_string: 'x' }))
  check(`${name}: a section that is not in the file`, noSection.same && noSection.bytesSame && noSection.there.said.startsWith('THROWN '), tell(noSection))
  const occupied = await pair(name, dir, twins, 'occupied.yml', SERVICE, 'whole', () => ({ old_string: '', new_string: 'x\n' }))
  check(`${name}: an empty old_string where a file with content stands`, occupied.same && occupied.bytesSame && occupied.there.said.startsWith('THROWN '), tell(occupied))
  for (const path of [join(dir, 'huge.log'), join(twins, 'huge.log')]) {
    writeFileSync(path, '')
    truncateSync(path, 1024 * 1024 * 1024 + 4096)
  }
  const hugeAt = Date.now()
  const huge = await edit({ file_path: remote(join(dir, 'huge.log')), append: 'x' })
  const hugeHere = await edit({ file_path: join(twins, 'huge.log'), append: 'x' })
  check(`${name}: a file past the size an edit takes is refused by its size, without being read`, huge.said === hugeHere.said && huge.said.startsWith('THROWN File is too large to edit (') && Date.now() - hugeAt < 10_000, `${huge.said} | ${hugeHere.said} after ${Date.now() - hugeAt} ms`)
  for (const path of [join(dir, 'huge.log'), join(twins, 'huge.log')]) rmSync(path)
  const changed = join(dir, 'changed.yml')
  const changedTwin = join(twins, 'changed.yml')
  const context = contextOf()
  const contextHere = contextOf()
  for (const path of [changed, changedTwin]) writeFileSync(path, SERVICE)
  await read(remote(changed), context)
  await read(changedTwin, contextHere)
  for (const path of [changed, changedTwin]) {
    writeFileSync(path, SERVICE.replace('name: app', 'name: somebody else'))
    const later = new Date(Date.now() + 20_000)
    utimesSync(path, later, later)
  }
  const stale = await edit({ file_path: remote(changed), old_string: 'host: a', new_string: 'host: mine' }, context)
  const staleHere = await edit({ file_path: changedTwin, old_string: 'host: a', new_string: 'host: mine' }, contextHere)
  check(`${name}: a file changed by someone else since it was read is not edited`, stale.said === staleHere.said.replaceAll(changedTwin, remote(changed)) && stale.said.startsWith('THROWN ') && textAt(changed) === SERVICE.replace('name: app', 'name: somebody else'), `${stale.said.slice(0, 300)} | ${staleHere.said.slice(0, 300)}`)

  const quick = join(dir, 'same-second.yml')
  const quickTwin = join(twins, 'same-second.yml')
  for (const path of [quick, quickTwin]) writeFileSync(path, SERVICE)
  const quickly = contextOf()
  const quicklyHere = contextOf()
  await read(remote(quick), quickly)
  await read(quickTwin, quicklyHere)
  await edit({ file_path: remote(quick), old_string: 'port: 80\nhost', new_string: 'port: 8080\nhost' }, quickly)
  await edit({ file_path: quickTwin, old_string: 'port: 80\nhost', new_string: 'port: 8080\nhost' }, quicklyHere)
  const written = statSync(quick).mtime
  writeFileSync(quick, `${textAt(quick)}someone: else\n`)
  utimesSync(quick, written, new Date(Math.floor(written.getTime() / 1000) * 1000))
  writeFileSync(quickTwin, `${textAt(quickTwin)}someone: else\n`)
  utimesSync(quickTwin, new Date(Date.now() + 20_000), new Date(Date.now() + 20_000))
  const sameSecond = await edit({ file_path: remote(quick), old_string: 'name: app', new_string: 'name: mine' }, quickly)
  const sameSecondHere = await edit({ file_path: quickTwin, old_string: 'name: app', new_string: 'name: mine' }, quicklyHere)
  check(`${name}: a file another writer changed in the same second as Mercury's own last edit, its time unmoved, is known to have changed`, sameSecond.said === sameSecondHere.said.replaceAll(quickTwin, remote(quick)) && sameSecond.said.startsWith('THROWN ') && textAt(quick).includes('name: app') && textAt(quick).endsWith('someone: else\n'), `${sameSecond.said.slice(0, 300)} | ${sameSecondHere.said.slice(0, 300)}`)

  section(`${name} · what an edit on another machine answers in words of its own`)
  const gone = await edit({ file_path: remote(join(dir, 'nothing-like-it.yml')), old_string: 'a', new_string: 'b' })
  check(`${name}: a file that is not there`, gone.said === 'THROWN There is no file at that path on box.', gone.said)
  writeFileSync(join(dir, 'report.md'), 'report\n')
  const near = await edit({ file_path: remote(join(dir, 'report.txt')), old_string: 'a', new_string: 'b' })
  check(`${name}: and where one name in the folder differs only by its ending, it is offered`, near.said === `THROWN There is no file at that path on box. Did you mean ${remote(join(dir, 'report.md'))}?`, near.said)
  mkdirSync(join(dir, 'a-folder'))
  const folder = await edit({ file_path: remote(join(dir, 'a-folder')), old_string: 'a', new_string: 'b' })
  check(`${name}: a folder`, folder.said === `THROWN The path is a directory, not a file: ${remote(join(dir, 'a-folder'))}`, folder.said)
  const fifo = join(dir, 'a-pipe')
  spawnSync('mkfifo', [fifo])
  if (existsSync(fifo)) {
    const pipe = await edit({ file_path: remote(fifo), append: 'x' })
    check(`${name}: a named pipe is not opened`, pipe.said === `THROWN Editing ${remote(fifo)} is not allowed: it is a named pipe, not a file.`, pipe.said)
  }
  writeFileSync(join(dir, 'book.ipynb'), '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n')
  const notebook = await edit({ file_path: remote(join(dir, 'book.ipynb')), old_string: '"cells":[]', new_string: '"cells":[1]' })
  check(`${name}: a notebook`, notebook.said === 'THROWN Edit does not change a notebook on another machine, and NotebookEdit works on this machine\'s files; change it with a command run on box.' && textAt(join(dir, 'book.ipynb')).includes('"cells":[]'), notebook.said)
  const entry = await validated({ file_path: `${remote(join(dir, 'bundle.zip'))}:README.txt`, old_string: 'a', new_string: 'b' })
  check(`${name}: an entry inside an archive on another machine`, entry.result === false && entry.message === `${remote(join(dir, 'bundle.zip'))}:README.txt names an entry inside an archive or a database on another machine, which Write and Edit do not change.`, String(entry.message))
  const bare = await validated({ file_path: 'ssh://', old_string: 'a', new_string: 'b' })
  const bareWrite = await validated({ file_path: 'ssh://', content: 'x' }, {}, FileWriteTool)
  check(`${name}: ssh:// alone names no file, for Edit and for Write`, bare.result === false && bare.message === 'ssh:// alone is the list of hosts, which Read shows; Write and Edit need a file: ssh://<host>/<path>.' && bareWrite.result === false && bareWrite.message === bare.message, `${bare.message} | ${bareWrite.message}`)

  section(`${name} · the rules`)
  closeRemoteConnections()
  const connected = world.connectLines().length
  const asked = await decided(remote(join(dir, 'exact.yml')))
  const shaped = await validated({ file_path: remote(join(dir, 'exact.yml')), old_string: 'never looked for', new_string: 'x' })
  check(`${name}: with no rule the default mode asks and offers all edits on the host for the session; neither the question nor the check of the input makes a connection`, asked.behavior === 'ask' && JSON.stringify(asked.suggestions?.at(-1)?.rules) === JSON.stringify([{ toolName: 'Edit', ruleContent: 'ssh://box/**' }]) && shaped.result === true && world.connectLines().length === connected, `${JSON.stringify(asked)} ${JSON.stringify(shaped)}`)
  check(`${name}: a rule that allows edits on the host allows the edit; one that allows reading does not`, (await decided(remote(join(dir, 'exact.yml')), { allow: ['Edit(ssh://box/**)'] })).behavior === 'allow' && (await decided(remote(join(dir, 'exact.yml')), { allow: ['Read(ssh://box/**)'] })).behavior === 'ask')
  const guarded = join(dir, 'guarded')
  mkdirSync(guarded)
  writeFileSync(join(guarded, 'keep.txt'), 'keep\n')
  symlinkSync(guarded, join(dir, 'side-door'))
  const deny = { allow: ['Edit(ssh://box/**)', 'Read(ssh://box/**)'], deny: [`Edit(ssh://box${guarded}/**)`] }
  const denied = await validated({ file_path: remote(join(guarded, 'keep.txt')), old_string: 'keep', new_string: 'lose' }, deny)
  check(`${name}: a deny rule refuses the edit by its own path before anything connects`, denied.result === false && denied.message === `Editing ${remote(join(guarded, 'keep.txt'))} is denied by the rule Edit(ssh://box${guarded}/**) in your user settings.`, String(denied.message))
  const sneaking = contextOf(deny)
  await read(remote(join(dir, 'side-door', 'keep.txt')), sneaking)
  const sneaked = await edit({ file_path: remote(join(dir, 'side-door', 'keep.txt')), old_string: 'keep', new_string: 'lose' }, sneaking)
  check(`${name}: and through a folder that is a link, once the remote machine has said where it leads: nothing is changed`, sneaked.said.startsWith('THROWN Editing ') && sneaked.said.includes('is denied by the rule') && textAt(join(guarded, 'keep.txt')) === 'keep\n', sneaked.said)
  mkdirSync(join(STORE, 'runtime', 'current'), { recursive: true })
  writeFileSync(join(STORE, 'runtime', 'current', 'mercury.mjs'), 'the runtime\n')
  const store = await edit({ file_path: remote(join(STORE, 'runtime', 'current', 'mercury.mjs')), append: 'x' }, contextOf({ allow: ['Edit(ssh://box/**)'] }))
  check(`${name}: Mercury's own runtime on this machine is refused through the host`, store.said.startsWith('THROWN ') && store.said.includes('is refused') && textAt(join(STORE, 'runtime', 'current', 'mercury.mjs')) === 'the runtime\n', store.said)
  rmSync(join(STORE, 'runtime'), { recursive: true, force: true })
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
  const lost = await edit({ file_path: remote(file), old_string: 'as it was read', new_string: 'mine' }, context)
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
  const lostHere = await edit({ file_path: twin, old_string: 'as it was read', new_string: 'mine' }, contextHere)
  check('the edit is refused in the words of a file modified since it was read, and the other writer\'s line stands', lost.said === lostHere.said && lost.said.startsWith('THROWN ') && textAt(file) === 'as it was read\nsomeone else\n', `${lost.said} | ${lostHere.said} | ${JSON.stringify(textAt(file))}`)
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
      await edits(world)
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

console.log(`\nremote edit: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
