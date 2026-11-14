#!/usr/bin/env bun
import { closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-read-formats-')))
const project = join(launch, 'project')
const STORE = join(launch, 'mercury-home')
const PRIVATE = join(launch, 'private-tmp')
for (const dir of [project, STORE, PRIVATE]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = STORE
process.env.MERCURY_TMPDIR = PRIVATE
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit, cacheKeys } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

const PORT = 27064
const FIXTURES = join(import.meta.dir, '..', 'tools', 'fixtures', 'read-formats')
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

type Input = Record<string, unknown> & { file_path: string }
type Answer = { said: string; data: Record<string, unknown> | null; extra: string }
const contextOf = (deny: string[] = []) =>
  ({
    messages: [],
    options: {},
    readFileState: createFileStateCacheWithSizeLimit(100),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), alwaysDenyRules: deny.length > 0 ? { userSettings: deny } : {} } }),
  }) as never
let turns = 0
const answer = async (input: Input, context: unknown = contextOf()): Promise<Answer> => {
  try {
    const result = (await FileReadTool.call(input as never, context as never, undefined, { message: { id: `formats-${turns++}` } })) as { data: Record<string, unknown>; newMessages?: unknown[] }
    const block = FileReadTool.mapToolResultToToolResultBlockParam(result.data as never, 'proof')
    return { said: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), data: result.data, extra: JSON.stringify(result.newMessages ?? []) }
  } catch (error) {
    return { said: `THROWN ${error instanceof Error ? error.message : String(error)}`, data: null, extra: '' }
  }
}
const remote = (path: string): string => `ssh://box${path}`

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([(x * 40) & 255, (y * 40) & 255, 128, 255], y * (1 + width * 4) + 1 + x * 4)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

async function formats(world: RemoteWorld): Promise<void> {
  const name = world.transport
  const dir = join(world.data, 'formats')
  mkdirSync(dir, { recursive: true })
  for (const file of readdirSync(FIXTURES)) copyFileSync(join(FIXTURES, file), join(dir, file))
  writeFileSync(join(dir, 'picture.png'), png(6, 4))
  writeFileSync(join(dir, 'picture'), png(6, 4))
  writeFileSync(join(dir, 'book.ipynb'), JSON.stringify({ cells: [{ cell_type: 'markdown', metadata: {}, source: ['# a title'] }, { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['print(1)\n'] }], metadata: { kernelspec: { language: 'python', name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 }))
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 250, 251, 252]))
  writeFileSync(join(dir, 'odd name (v2) é.zip'), statSync(join(FIXTURES, 'sample.zip')).size > 0 ? Buffer.from(await Bun.file(join(FIXTURES, 'sample.zip')).arrayBuffer()) : Buffer.alloc(0))
  const all: string[] = []
  const same = async (label: string, input: Record<string, unknown>, file: string, entry = ''): Promise<void> => {
    const here = await answer({ ...input, file_path: `${join(dir, file)}${entry}` })
    const there = await answer({ ...input, file_path: `${remote(join(dir, file))}${entry}` })
    all.push(there.said, there.extra, JSON.stringify(there.data ?? {}))
    const expected = here.said.replaceAll(join(dir, file), remote(join(dir, file)))
    check(`${name}: ${label}`, there.said === expected && !there.said.startsWith('THROWN'), `remote ${JSON.stringify(there.said.slice(0, 240))} local ${JSON.stringify(expected.slice(0, 240))}`)
  }

  section(`${name} · archives, databases and documents on another machine read as they do here`)
  await same('a zip lists its entries', {}, 'sample.zip')
  await same('an entry of a zip, with a window', { offset: 2, limit: 1 }, 'sample.zip', ':README.txt')
  await same('a tar lists its entries', {}, 'sample.tar')
  await same('an entry of a tar', {}, 'sample.tar', ':sub/notes.md')
  await same('an entry of a tgz', {}, 'sample.tgz', ':manifest.txt')
  await same('a zip whose name has spaces, brackets and an accent', {}, 'odd name (v2) é.zip')
  await same('a sqlite database: schema, counts and sample rows', {}, 'sample.sqlite')
  await same('one table of it', {}, 'sample.sqlite', ':widgets')
  for (const file of ['sample.docx', 'sample.xlsx', 'sample.pptx', 'sample.odt', 'sample.epub', 'sample.rtf']) await same(`${file} as text`, {}, file)
  await same('a document read by ranges', { ranges: ['1-2'] }, 'sample.docx')

  section(`${name} · an image and a notebook`)
  for (const file of ['picture.png', 'picture']) {
    const here = await answer({ file_path: join(dir, file) })
    const there = await answer({ file_path: remote(join(dir, file)) })
    all.push(there.said, there.extra, JSON.stringify(there.data ?? {}))
    const image = (data: Record<string, unknown> | null): { base64?: string; type?: string; caption?: string } => (data?.file ?? {}) as { base64?: string; type?: string; caption?: string }
    check(
      `${name}: ${file === 'picture' ? 'an image with no extension, known by its first bytes' : 'a PNG'} comes back as the same picture, captioned by its remote path`,
      there.data?.type === 'image' && image(there.data).base64 === image(here.data).base64 && (image(there.data).base64 ?? '').length > 40 && (image(there.data).caption ?? '') === (image(here.data).caption ?? '').replaceAll(join(dir, file), remote(join(dir, file))),
      `${there.said.slice(0, 200)} | ${here.said.slice(0, 120)}`,
    )
  }
  const bookHere = await answer({ file_path: join(dir, 'book.ipynb') })
  const book = await answer({ file_path: remote(join(dir, 'book.ipynb')) })
  all.push(book.said, book.extra, JSON.stringify(book.data ?? {}))
  check(`${name}: a notebook comes back as its cells, named by its remote path`, book.data?.type === 'notebook' && book.said === bookHere.said && (book.data.file as { filePath: string }).filePath === remote(join(dir, 'book.ipynb')) && JSON.stringify((book.data.file as { cells: unknown[] }).cells) === JSON.stringify((bookHere.data?.file as { cells: unknown[] }).cells), book.said.slice(0, 300))

  section(`${name} · what is refused, and what is left behind`)
  const blob = await answer({ file_path: remote(join(dir, 'blob.bin')) })
  check(`${name}: a file with no reader for its kind is refused in today's words`, blob.said === 'THROWN This tool cannot read binary files, and .bin looks binary — reach for a tool built for that format instead.', blob.said)
  const heavy = join(dir, 'heavy.zip')
  const fd = openSync(heavy, 'w')
  ftruncateSync(fd, 17 * 1024 * 1024)
  closeSync(fd)
  const tooBigHere = await answer({ file_path: heavy })
  let travelled = -1
  if (world.transport === 'local') {
    closeRemoteConnections()
    process.env.REMOTE_KIT_COUNT = join(world.scratch, 'bytes-from-the-remote')
  }
  const tooBig = await answer({ file_path: remote(heavy) })
  if (world.transport === 'local') {
    travelled = existsSync(process.env.REMOTE_KIT_COUNT!) ? statSync(process.env.REMOTE_KIT_COUNT!).size : 0
    closeRemoteConnections()
    delete process.env.REMOTE_KIT_COUNT
  }
  check(`${name}: an archive past the size an archive is read at is refused by its size in the local words${travelled === -1 ? '' : `, before it is fetched (${travelled} bytes came over the connection)`}`, tooBig.said === tooBigHere.said.replaceAll(heavy, remote(heavy)) && tooBig.said.startsWith('THROWN Container file (17MB) exceeds') && travelled < 4096, `${tooBig.said} | ${travelled}`)
  const denied = (await FileReadTool.validateInput!({ file_path: `${remote(join(dir, 'sample.zip'))}:README.txt` } as never, contextOf([`Read(ssh://box${join(dir, 'sample.zip')})`]))) as { result: boolean; message?: string }
  check(`${name}: a rule that denies an archive denies an entry of it, before anything connects`, denied.result === false && (denied.message ?? '').includes('is denied by the rule'), String(denied.message))
  const missing = await answer({ file_path: `${remote(join(dir, 'nothing.zip'))}:README.txt` })
  check(`${name}: an entry of an archive that is not there is a missing file on that host`, missing.said === 'THROWN There is no file at that path on box.', missing.said)
  const kept = contextOf()
  await answer({ file_path: `${remote(join(dir, 'sample.zip'))}:README.txt` }, kept)
  check(`${name}: nothing said, attached or kept names the private copy`, all.every(text => !text.includes(PRIVATE) && !text.includes('/copy-')) && cacheKeys((kept as { readFileState: never }).readFileState).every(key => !key.includes(PRIVATE)), all.find(text => text.includes(PRIVATE) || text.includes('/copy-'))?.slice(0, 300) ?? JSON.stringify(cacheKeys((kept as { readFileState: never }).readFileState)))
  const copies = readdirSync(PRIVATE, { recursive: true }).map(String).filter(entry => /copy-/.test(entry))
  check(`${name}: and no private copy is left on this disk`, copies.length === 0, copies.join(' '))
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
      await formats(world)
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

console.log(`\nremote read formats: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
