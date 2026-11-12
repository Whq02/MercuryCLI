#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { dirname, join, sep } from 'node:path'

type SceneArgs = { path?: string; offset?: number; limit?: number; direct?: boolean; vanishIn?: string }

const sceneAt = process.argv.indexOf('--scene')
if (sceneAt !== -1) {
  await runScene(JSON.parse(process.argv[sceneAt + 1] ?? '{}') as SceneArgs)
  process.exit(0)
}

async function runScene(args: SceneArgs): Promise<void> {
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const say = (value: unknown): void => {
    process.stdout.write(`SCENE ${JSON.stringify(value)}\n`)
  }
  const tool = FileReadTool as unknown as { validateInput: Function; call: Function; mapToolResultToToolResultBlockParam: Function }
  const context = { readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
  const input = { file_path: args.path!, ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) }
  if (args.direct !== true) {
    const verdict = await tool.validateInput(input, context)
    if (verdict.result === false) return say({ door: 'check', refused: String(verdict.message) })
  }
  if (args.vanishIn !== undefined) {
    if (!realpathSync(dirname(args.path!)).startsWith(args.vanishIn + sep)) throw new Error('the path to remove lies outside the world of this proof')
    rmSync(args.path!)
  }
  try {
    const out = await tool.call(input, context, null, { uuid: '00000000-0000-0000-0000-000000000006', message: { id: 'msg_fixture' } })
    const block = tool.mapToolResultToToolResultBlockParam(out.data, 'toolu_read')
    return say({ door: 'read', type: out.data.type, shown: typeof block.content === 'string' ? block.content : '' })
  } catch (err) {
    return say({ door: 'read', refused: err instanceof Error ? err.message : String(err) })
  }
}

const { bound, childEnv, DIST, MODEL, NODE, SCRATCH_ROOT } = await import('../daemon/dupline-world.ts')
const { seedScratchHome, startScriptedFixture } = await import('../lib/scriptedTurn.ts')

const WIN = process.platform === 'win32'
const KEEP = process.argv.includes('--keep')
const MIB = 1024 * 1024
const RUNAWAY_BYTES = 1024 * MIB

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

const world = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'read-not-a-file-')))
const files = join(world, 'files')
mkdirSync(files, { recursive: true })
console.log(`world: ${world}`)

const sceneEnv: Record<string, string | undefined> = {
  ...process.env,
  MERCURY_CONFIG_DIR: join(world, 'scene-home'),
  MERCURY_BARE: '1',
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  BROWSER: '/usr/bin/true',
}
delete sceneEnv.NODE_ENV
delete sceneEnv.MERCURY_READ_TARGETS
mkdirSync(join(world, 'scene-home'), { recursive: true })

function residentBytesOf(pid: number): number {
  try {
    const kib = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    if (kib) return Number(kib[1]) * 1024
  } catch {
  }
  const listed = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
  return (Number((listed.stdout ?? '').trim()) || 0) * 1024
}

type SceneRun = { returned: boolean; value: { door?: string; refused?: string; type?: string; shown?: string }; ms: number; cut: 'deadline' | 'memory' | null; stderr: string }

async function scene(args: SceneArgs, deadlineMs: number): Promise<SceneRun> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, import.meta.path, '--scene', JSON.stringify(args)], { env: sceneEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let cut: SceneRun['cut'] = null
  const deadline = setTimeout(() => {
    cut = cut ?? 'deadline'
    proc.kill('SIGKILL')
  }, deadlineMs)
  const watch = setInterval(() => {
    if (residentBytesOf(proc.pid) <= RUNAWAY_BYTES) return
    cut = cut ?? 'memory'
    proc.kill('SIGKILL')
  }, 100)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(deadline)
  clearInterval(watch)
  const line = stdout.split('\n').find(l => l.startsWith('SCENE '))
  return { returned: line !== undefined, value: line === undefined ? {} : (JSON.parse(line.slice(6)) as SceneRun['value']), ms: Date.now() - started, cut, stderr }
}
const how = (run: SceneRun): string =>
  run.returned ? `${j(run.value).slice(0, 500)} in ${run.ms} ms` : run.cut === 'memory' ? `killed after ${run.ms} ms: its resident memory passed ${Math.round(RUNAWAY_BYTES / MIB)} MiB` : run.cut === 'deadline' ? `no answer in ${run.ms} ms: killed at the deadline` : `it ended without an answer: ${run.stderr.slice(-300)}`

const refusalOf = (path: string, kind: 'a named pipe' | 'a socket' | 'a device'): string =>
  `Reading ${path} is not allowed: it is ${kind}, not a file or a folder, and reading it could hang or never end; use a shell command with a timeout or a byte limit instead.`
const NOT_THERE = 'There is no file at that path.'
const reportLines = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the report`)
const reportText = reportLines.join('\n') + '\n'

const textPath = join(files, 'report.md')
const linkPath = join(files, 'report-link.md')
const folderPath = join(files, 'a-folder')
const goingPath = join(files, 'going.md')
const missingPath = join(files, 'never-written.md')
const pipePath = join(files, 'pipe.log')
const pipeLinkPath = join(files, 'pipe-link.log')
const zeroLinkPath = join(files, 'zeros.log')
const socketPath = join(world, 's')
writeFileSync(textPath, reportText)
writeFileSync(goingPath, reportText)
symlinkSync(textPath, linkPath)
mkdirSync(folderPath)
writeFileSync(join(folderPath, 'inside.txt'), 'inside\n')
const havePipe = !WIN && spawnSync('mkfifo', [pipePath]).status === 0

section('§1 a path that is neither a file nor a folder is refused in one sentence, before the read and at the read, and never opened')
if (!havePipe) {
  console.log('  [SKIP] no named pipe on this platform')
} else {
  symlinkSync(pipePath, pipeLinkPath)
  const checked = await scene({ path: pipePath }, bound(15_000))
  check('a named pipe nobody writes to: refused at the check, in the sentence that names it', checked.returned && checked.value.door === 'check' && checked.value.refused === refusalOf(pipePath, 'a named pipe'), how(checked))
  const read = await scene({ path: pipePath, direct: true }, bound(15_000))
  check('…and at the read itself, for a caller that skipped the check: the same sentence, nothing opened', read.returned && read.value.door === 'read' && read.value.refused === refusalOf(pipePath, 'a named pipe'), how(read))
  const linked = await scene({ path: pipeLinkPath, offset: 1, limit: 5 }, bound(15_000))
  check('a link to a named pipe: refused under the path that was asked for', linked.returned && linked.value.refused === refusalOf(pipeLinkPath, 'a named pipe'), how(linked))
}
if (WIN || !existsSync('/dev/zero')) {
  console.log('  [SKIP] no /dev/zero on this platform')
} else {
  symlinkSync('/dev/zero', zeroLinkPath)
  const device = await scene({ path: zeroLinkPath, offset: 1, limit: 5 }, bound(15_000))
  check('a link to a device that never ends: refused as a device, no byte of it read', device.returned && device.value.door === 'check' && device.value.refused === refusalOf(zeroLinkPath, 'a device'), how(device))
  const listed = await scene({ path: '/dev/zero' }, bound(15_000))
  check('/dev/zero by its own name keeps the sentence it had', listed.returned && listed.value.refused === 'Reading /dev/zero is not allowed: it is a device file that would hang or produce infinite output.', how(listed))
}
let listener: Server | null = null
if (!WIN) {
  listener = await new Promise<Server | null>(done => {
    const server = createServer()
    server.once('error', () => done(null))
    server.listen(socketPath, () => done(server))
  })
}
if (listener === null) {
  console.log('  [SKIP] no socket could be bound at a path here')
} else {
  const socket = await scene({ path: socketPath }, bound(15_000))
  check('a socket: refused as a socket', socket.returned && socket.value.door === 'check' && socket.value.refused === refusalOf(socketPath, 'a socket'), how(socket))
  await new Promise<void>(done => listener!.close(() => done()))
}

section('§2 a file, a folder, a link to a file and a path that is gone answer as they did')
{
  const plain = await scene({ path: textPath }, bound(30_000))
  check('a file: its lines, numbered', plain.returned && plain.value.type === 'text' && String(plain.value.shown).startsWith('1\tline 1 of the report\n2\tline 2 of the report'), how(plain))
  const linked = await scene({ path: linkPath }, bound(30_000))
  check('a link to a file: the lines of the file it names', linked.returned && linked.value.type === 'text' && String(linked.value.shown).startsWith('1\tline 1 of the report'), how(linked))
  const folder = await scene({ path: folderPath }, bound(30_000))
  check('a folder: its listing', folder.returned && folder.value.type === 'text' && String(folder.value.shown).startsWith('1\t(target: directory · owner: Read · entries: 1 shown of 1)\n2\tinside.txt'), how(folder))
  const gone = await scene({ path: goingPath, vanishIn: world }, bound(30_000))
  check('a file that vanishes between the check and the read: "There is no file at that path."', gone.returned && gone.value.door === 'read' && String(gone.value.refused).startsWith(NOT_THERE), how(gone))
  const missing = await scene({ path: missingPath }, bound(30_000))
  check('a path that was never there: the same sentence, at the read', missing.returned && missing.value.door === 'read' && String(missing.value.refused).startsWith(NOT_THERE), how(missing))
}

section('§3 the built product: a pipe where a file was read never stops a run or a resume')
type BundleRun = { code: number | null; outcome: Record<string, unknown> | null; ms: number; cut: boolean; stderr: string }
async function mercury(argv: string[], cwd: string, env: NodeJS.ProcessEnv, deadlineMs: number): Promise<BundleRun> {
  const started = Date.now()
  const proc = Bun.spawn([NODE, DIST, ...argv], { cwd, env: env as Record<string, string | undefined>, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let cut = false
  const deadline = setTimeout(() => {
    cut = true
    proc.kill('SIGKILL')
  }, deadlineMs)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(deadline)
  let outcome: Record<string, unknown> | null = null
  try {
    outcome = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? 'null') as Record<string, unknown> | null
  } catch {
    outcome = null
  }
  return { code, outcome, ms: Date.now() - started, cut, stderr }
}
const completed = (run: BundleRun): boolean => !run.cut && run.code === 0 && run.outcome?.status === 'completed'
const told = (run: BundleRun): string => (run.cut ? `no end in ${run.ms} ms: killed at the deadline` : `exit ${String(run.code)} · ${String(run.outcome?.status)} · ${String(run.outcome?.steps)} step(s) · ${run.stderr.slice(-200)}`)

const PIPE_ASK = 'read the pipe'
const TURN_ASK = 'read the log, then make it a pipe'
const READ_ASK = 'read the note'
const RESUME_ASK = 'go on from there'

if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
} else if (!havePipe) {
  console.log('  [SKIP] no named pipe on this platform')
} else {
  console.log(`build under proof: ${DIST}`)
  const home = join(world, 'run', 'home')
  const cwd = join(world, 'run', 'work')
  seedScratchHome(home, cwd)
  const waiting = join(cwd, 'waiting.pipe')
  const turning = join(cwd, 'turning.log')
  const note = join(cwd, 'note.txt')
  spawnSync('mkfifo', [waiting])
  writeFileSync(turning, reportText)
  writeFileSync(note, 'twenty bytes of text\n')
  const fixture = await startScriptedFixture(req => {
    const ask = req.ask.trim()
    if (ask === PIPE_ASK && req.step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: waiting } }]
    if (ask === TURN_ASK && req.step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: turning } }]
    if (ask === TURN_ASK && req.step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: `rm ${JSON.stringify(turning)} && mkfifo ${JSON.stringify(turning)}`, description: 'the log becomes a pipe' } }]
    if (ask === READ_ASK && req.step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: note } }]
    return [{ type: 'text', text: 'done' }]
  })
  const env = childEnv(home, Number(new URL(fixture.base).port))
  const asked = (ask: string): number => fixture.requests.filter(r => r.ask.trim() === ask).length
  const run = (ask: string, session: string, how_: '--session-id' | '--resume'): Promise<BundleRun> =>
    mercury(['run', ask, '--format', 'json', '--mode', 'sovereign', '--model', MODEL, how_, session], cwd, env, bound(45_000))

  const piped = await run(PIPE_ASK, randomUUID(), '--session-id')
  const answer = fixture.requests.find(r => r.ask.trim() === PIPE_ASK && r.step === 1)?.results[0]
  check('a run whose model reads a pipe: the call comes back refused in the sentence, and the run completes in two model calls', completed(piped) && asked(PIPE_ASK) === 2 && answer?.isError === true && String(answer?.text).includes(refusalOf(waiting, 'a named pipe')), `${told(piped)} · ${asked(PIPE_ASK)} request(s) · ${j(answer)}`)

  const turned = await run(TURN_ASK, randomUUID(), '--session-id')
  check("a run in which the model's own command turns a file it read into a pipe: the next step is not stopped by it, three model calls and done", completed(turned) && asked(TURN_ASK) === 3 && spawnSync('test', ['-p', turning]).status === 0, `${told(turned)} · ${asked(TURN_ASK)} request(s)`)

  const session = randomUUID()
  const first = await run(READ_ASK, session, '--session-id')
  rmSync(note)
  const swapped = spawnSync('mkfifo', [note]).status === 0
  const resumed = await run(RESUME_ASK, session, '--resume')
  check('a session that read a file which is a pipe when it is resumed: the resume asks the model once and completes', completed(first) && swapped && completed(resumed) && asked(RESUME_ASK) === 1, `${told(first)} · ${told(resumed)} · ${asked(RESUME_ASK)} request(s)`)
  await fixture.close()
}

if (failures === 0 && !KEEP) rmSync(world, { recursive: true, force: true })
else console.log(`\nworld kept: ${world}`)
console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('READ NOT A FILE RED')
  process.exit(1)
}
console.log('READ NOT A FILE GREEN')
