#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { deflateSync } from 'node:zlib'

type Road = 'read' | 'mention' | 'reference' | 'inspect' | 'query' | 'registry'
type ChildArgs = { road: Road; project: string; world: string; target?: string; pipe?: string; original?: string; pipes?: string[] }
type Round = { n?: number; path?: string; swapped?: boolean; outcome: 'ok' | 'refused' | 'other'; words: string; ms: number }

const childAt = process.argv.indexOf('--child')
if (childAt !== -1) {
  await runChild(JSON.parse(process.argv[childAt + 1] ?? '{}') as ChildArgs)
  process.exit(0)
}

async function runChild(args: ChildArgs): Promise<void> {
  const fs = { ...(await import('node:fs')) }
  const promises = { ...(await import('node:fs/promises')) }
  const { mock } = await import('bun:test')
  let statsSeen = 0
  let swapAfter = 0
  let swapped = false
  const afterStat = (path: unknown): void => {
    if (args.target === undefined || String(path) !== args.target) return
    statsSeen++
    if (swapped || statsSeen !== swapAfter) return
    swapped = true
    fs.renameSync(args.pipe!, args.target)
  }
  mock.module('node:fs', () => ({
    ...fs,
    statSync: (...a: unknown[]) => {
      const st = (fs.statSync as Function)(...a)
      afterStat(a[0])
      return st
    },
  }))
  mock.module('node:fs/promises', () => ({
    ...promises,
    stat: async (...a: unknown[]) => {
      const st = await (promises.stat as Function)(...a)
      afterStat(a[0])
      return st
    },
  }))
  const state = await import('../../src/bootstrap/state.ts')
  state.setOriginalCwd(args.project)
  state.setCwdState(args.project)
  state.setProjectRoot(args.project)
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const read = FileReadTool as unknown as { validateInput: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  const makeContext = (): Record<string, unknown> => ({ readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }), options: { tools: [], engineModel: 'claude-sonnet-5' } })
  const refusal = /not a file or a folder|[Nn]ot a regular file/
  const viaRead = async (file_path: string): Promise<string> => {
    const context = makeContext()
    const verdict = await read.validateInput({ file_path }, context)
    if (verdict.result === false) throw new Error(String(verdict.message))
    const out = await read.call({ file_path }, context, null, { uuid: '00000000-0000-0000-0000-000000000006', message: { id: 'msg_fixture' } })
    const block = read.mapToolResultToToolResultBlockParam(out.data, 'toolu_read')
    const shown = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    if (shown.includes('state: unavailable')) throw new Error(shown)
    return `${String(out.data.type)}: ${shown}`
  }
  const attempt = async (path: string): Promise<string> => {
    if (args.road === 'read') return viaRead(path)
    if (args.road === 'reference') return viaRead(`mercury://file/${path}`)
    if (args.road === 'mention') {
      const { generateFileAttachment } = await import('../../src/utils/attachments/fileAttachments.ts')
      const row = (await generateFileAttachment(path, makeContext() as never, 'at-mention')) as { type?: string } | null
      return row === null ? 'nothing attached' : String(row.type)
    }
    if (args.road === 'inspect') {
      const { InspectTool } = await import('../../src/tools/InspectTool/InspectTool.ts')
      const out = await (InspectTool as unknown as { call: Function }).call({ ref: `mercury://file/${path}` }, makeContext())
      if (out.data.state !== 'ok') throw new Error(String(out.data.result))
      return String(out.data.result)
    }
    const answer =
      args.road === 'query'
        ? ((await (await import('../../src/cli/headless/projectQuery.ts')).projectQuery({ op: 'resource', ref: `mercury://file/${path}` } as never, getEmptyToolPermissionContext())) as { state?: string; note?: string })
        : ((await (await import('../../src/services/resources/registry.ts')).resolveResource(`mercury://file/${path}`, { cwd: args.project, owner: (await import('../../src/services/run/resolveOwner.ts')).processMainOwner() })) as { state?: string; note?: string })
    if (answer.state !== 'ok') throw new Error(String(answer.note))
    return 'ok'
  }
  const told = async (path: string, extra: Partial<Round>): Promise<void> => {
    const started = Date.now()
    let round: Round
    try {
      round = { ...extra, outcome: 'ok', words: (await attempt(path)).slice(0, 90), ms: Date.now() - started }
    } catch (err) {
      const words = err instanceof Error ? err.message : String(err)
      round = { ...extra, outcome: refusal.test(words) ? 'refused' : 'other', words: words.slice(0, 600), ms: Date.now() - started }
    }
    if (extra.n !== undefined) round.swapped = swapped
    process.stdout.write(`ROUND ${JSON.stringify(round)}\n`)
  }
  if (args.pipes !== undefined) {
    for (const path of args.pipes) await told(path, { path })
  } else {
    const inWorld = (path: string): boolean => realpathSync(dirname(path)).startsWith(args.world + sep)
    if (!inWorld(args.target!) || !inWorld(args.pipe!)) throw new Error('the paths to swap lie outside the world of this proof')
    for (let n = 1; n <= 32; n++) {
      fs.rmSync(args.target!, { force: true })
      fs.copyFileSync(args.original!, args.target!)
      if (!fs.existsSync(args.pipe!) && spawnSync('mkfifo', [args.pipe!]).status !== 0) throw new Error('mkfifo failed')
      statsSeen = 0
      swapped = false
      swapAfter = n
      await told(args.target!, { n })
      if (!swapped) break
    }
  }
  process.stdout.write('DONE\n')
}

const { bound, SCRATCH_ROOT } = await import('../daemon/dupline-world.ts')
const { seedScratchHome } = await import('../lib/scriptedTurn.ts')
const { pdfFixture, textPage } = await import('../document-read/fixtures.ts')

const ROOT = join(import.meta.dir, '..', '..')
const KEEP = process.argv.includes('--keep')
let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

if (process.platform === 'win32' || spawnSync('mkfifo', ['--help']).error !== undefined) {
  console.log('  [SKIP] no named pipe on this platform: the reader opens a regular file as before there, and there is nothing to swap in')
  console.log('\n0 checks, 0 failures')
  console.log('READ BY DESCRIPTOR GREEN')
  process.exit(0)
}

const world = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'read-by-descriptor-')))
const project = join(world, 'project')
const originals = join(world, 'originals')
const sceneHome = join(world, 'scene-home')
seedScratchHome(sceneHome, project)
mkdirSync(originals, { recursive: true })
console.log(`world: ${world}`)

function crc32(bytes: Uint8Array): number {
  let c = ~0
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function smallPng(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(16, 0)
  ihdr.writeUInt32BE(16, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(48, 0x7f)])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 16 }, () => row)))), pngChunk('IEND', Buffer.alloc(0))])
}

const samples = join(ROOT, 'scripts', 'tools', 'fixtures', 'read-formats')
const kinds: Array<{ kind: string; name: string; make: (path: string) => void; shows: string }> = [
  { kind: 'text', name: 'report.md', make: path => writeFileSync(path, Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the report`).join('\n') + '\n'), shows: 'line 1 of the report' },
  { kind: 'image', name: 'picture.png', make: path => writeFileSync(path, smallPng()), shows: 'image' },
  { kind: 'notebook', name: 'book.ipynb', make: path => writeFileSync(path, JSON.stringify({ cells: [{ cell_type: 'code', id: 'sum', execution_count: 1, metadata: {}, outputs: [], source: ['print(1 + 2)'] }], metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 })), shows: 'print(1 + 2)' },
  { kind: 'pdf', name: 'paper.pdf', make: path => writeFileSync(path, pdfFixture([textPage('The first page of the paper.')])), shows: 'The first page of the paper.' },
  { kind: 'document', name: 'sample.docx', make: path => copyFileSync(join(samples, 'sample.docx'), path), shows: 'Quarterly Review Heading' },
  { kind: 'zip archive', name: 'sample.zip', make: path => copyFileSync(join(samples, 'sample.zip'), path), shows: 'archive: zip' },
  { kind: 'tar archive', name: 'sample.tar', make: path => copyFileSync(join(samples, 'sample.tar'), path), shows: 'archive: tar' },
  { kind: 'gzipped tar archive', name: 'sample.tgz', make: path => copyFileSync(join(samples, 'sample.tgz'), path), shows: 'archive: tgz' },
  { kind: 'sqlite database', name: 'sample.sqlite', make: path => copyFileSync(join(samples, 'sample.sqlite'), path), shows: 'database: sqlite' },
]
for (const item of kinds) item.make(join(originals, item.name))

const childEnv: Record<string, string | undefined> = {
  ...process.env,
  MERCURY_CONFIG_DIR: sceneHome,
  MERCURY_BARE: '1',
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  BROWSER: '/usr/bin/true',
}
delete childEnv.NODE_ENV
delete childEnv.MERCURY_READ_TARGETS
delete childEnv.MERCURY_REFS

type Played = { rounds: Round[]; done: boolean; cut: boolean; ms: number; stderr: string }
async function play(args: ChildArgs, deadlineMs: number): Promise<Played> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, import.meta.path, '--child', JSON.stringify(args)], { env: childEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let cut = false
  const deadline = setTimeout(() => {
    cut = true
    proc.kill('SIGKILL')
  }, deadlineMs)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(deadline)
  const lines = stdout.split('\n')
  return { rounds: lines.filter(line => line.startsWith('ROUND ')).map(line => JSON.parse(line.slice(6)) as Round), done: lines.includes('DONE'), cut, ms: Date.now() - started, stderr }
}
const how = (played: Played): string =>
  `${played.cut ? `killed at the deadline after ${played.ms} ms, inside round ${played.rounds.length + 1}` : played.done ? 'returned' : `ended early: ${played.stderr.slice(-300)}`} · ${j(played.rounds.map(round => [round.n ?? round.path?.split('.').pop(), round.swapped === true ? 'swapped' : round.swapped === false ? 'not swapped' : '', round.outcome, round.outcome === 'refused' ? '' : round.words.slice(0, 60)]))}`

async function walk(road: Road, item: (typeof kinds)[number]): Promise<Played> {
  const dir = join(project, `${road}-${item.name.replace(/\W/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  return play({ road, project, world, target: join(dir, item.name), pipe: join(dir, `the-pipe-${item.name}`), original: join(originals, item.name) }, bound(40_000))
}
function judge(label: string, played: Played, shows?: string): void {
  const swappedRounds = played.rounds.filter(round => round.swapped === true)
  const last = played.rounds.at(-1)
  const skipped = swappedRounds.filter(round => round.outcome === 'ok' && round.words === 'nothing attached').length
  console.log(`  ${label}: ${swappedRounds.length} swap position(s): ${swappedRounds.filter(round => round.outcome === 'refused').length} refused, ${skipped} skipped with nothing attached, ${swappedRounds.filter(round => round.outcome === 'ok').length - skipped} answered`)
  const asItself = (round: Round): boolean => round.outcome === 'ok' && (shows === undefined || round.words.includes(shows))
  check(`${label}: every swap between a stat of the path and the next open is answered, by a refusal or by the file's own content, and none stands on the pipe`, played.done && !played.cut && swappedRounds.length >= 1 && swappedRounds.every(round => round.outcome === 'refused' || asItself(round)), how(played))
  check(`${label}: with no swap the file is read as itself`, played.done && last !== undefined && last.swapped === false && asItself(last), how(played))
}

section('§1 a file that becomes a pipe after the path was looked at: Read, for each kind of file it opens')
for (const item of kinds) judge(`a ${item.kind}`, await walk('read', item), item.shows)

section('§2 the same swap on the roads that reach a file by reference, and through a mention')
{
  const text = kinds[0]!
  judge('Read by reference', await walk('reference', text), 'state: ok')
  judge('Inspect', await walk('inspect', text))
  judge('the headless project query', await walk('query', text))
  judge('the resource registry', await walk('registry', text))
  judge('a mention of a text file', await walk('mention', text))
  judge('a mention of a PDF', await walk('mention', kinds[3]!))
}

section('§3 a pipe from the start, named for each kind: Read refuses it in the sentence, a mention skips it at once')
{
  const dir = join(project, 'pipes')
  mkdirSync(dir, { recursive: true })
  const pipes = ['txt', 'png', 'ipynb', 'pdf', 'docx', 'zip', 'tar', 'tgz', 'sqlite', 'mp3'].map(ext => join(dir, `waiting.${ext}`))
  for (const path of pipes) spawnSync('mkfifo', [path])
  const sentence = (path: string): string => `Reading ${path} is not allowed: it is a named pipe, not a file or a folder, and reading it could hang or never end; use a shell command with a timeout or a byte limit instead.`
  const viaRead = await play({ road: 'read', project, world, pipes }, bound(60_000))
  check('Read: each of the ten is refused in the sentence that names it', viaRead.done && viaRead.rounds.length === pipes.length && viaRead.rounds.every((round, index) => round.outcome === 'refused' && round.words === sentence(pipes[index]!)), how(viaRead))
  const viaMention = await play({ road: 'mention', project, world, pipes }, bound(60_000))
  const slowest = Math.max(0, ...viaMention.rounds.map(round => round.ms))
  console.log(`  the slowest mention of the ten: ${slowest} ms (${viaMention.rounds.find(round => round.ms === slowest)?.path?.split('.').pop() ?? 'none'})`)
  check('a mention: each of the ten is skipped, nothing attached, none waited on', viaMention.done && viaMention.rounds.length === pipes.length && viaMention.rounds.every(round => round.outcome === 'ok' && round.words === 'nothing attached' && round.ms < bound(5_000)), how(viaMention))
}

if (failures === 0 && !KEEP) rmSync(world, { recursive: true, force: true })
else console.log(`\nworld kept: ${world}`)
console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('READ BY DESCRIPTOR RED')
  process.exit(1)
}
console.log('READ BY DESCRIPTOR GREEN')
