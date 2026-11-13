#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

type SceneArgs = { path?: string; text?: string; shown?: string; paths?: Record<string, string> }

const sceneAt = process.argv.indexOf('--scene')
if (sceneAt !== -1) {
  await runScene(process.argv[sceneAt + 1] ?? '', JSON.parse(process.argv[sceneAt + 2] ?? '{}') as SceneArgs)
  process.exit(0)
}

async function runScene(name: string, args: SceneArgs): Promise<void> {
  const ledger = await import('../../src/services/changeTransaction/seenLines.ts')
  const say = (value: unknown): void => {
    process.stdout.write(`SCENE ${JSON.stringify(value)}\n`)
  }
  if (name === 'generation') return say({ generation: ledger.fileGeneration(args.path!) })
  if (name === 'written') return say({ generation: ledger.generationOfWrittenBytes(args.path!, Buffer.from(args.text ?? '')) })
  if (name === 'parity') {
    const paths = args.paths ?? {}
    const text = readFileSync(paths.text!)
    const other = Buffer.from(text)
    other[0] = other[0] === 0x58 ? 0x59 : 0x58
    return say({
      generations: Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, ledger.fileGeneration(path)])),
      writtenSame: ledger.generationOfWrittenBytes(paths.text!, text),
      writtenOtherBytes: ledger.generationOfWrittenBytes(paths.text!, other),
      writtenOtherLength: ledger.generationOfWrittenBytes(paths.text!, text.subarray(1)),
      bound: (ledger.SEEN_LINES_BOUNDS as { fileBytes?: number }).fileBytes ?? null,
    })
  }
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
  const owner = processMainOwner()
  if (name === 'rebuild') {
    ledger._resetSeenLinesForTesting()
    const summary = ledger.rebuildSeenLinesFromTranscript(owner, [
      { type: 'assistant', uuid: 'r1-a', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: args.path! } }] } },
      { type: 'user', uuid: 'r1-u', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: args.shown ?? '' }] } },
    ])
    const seen = ledger.seenLinesOf(owner, args.path!)
    const verdict = ledger.checkSeenLines(owner, args.path!, seen?.generation ?? 'm0:0:none', [{ index: 0, start: 1, end: 1, replace: '' }])
    return say({ summary, ranges: seen?.ranges ?? null, ok: verdict.ok, hint: verdict.ok ? '' : verdict.hint })
  }
  if (name === 'knowledge') {
    const { readKnowledgeRefusal } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
    const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
    const context = { readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
    return say({ refusal: readKnowledgeRefusal(context as never, args.path!, 'the-log', args.text ?? '', undefined, [{ start: 1, end: 1 }]) })
  }
  throw new Error(`no scene named ${name}`)
}

const { bound, childEnv, DIST, MODEL, NODE, SCRATCH_ROOT } = await import('../daemon/dupline-world.ts')
const { seedScratchHome, startScriptedFixture } = await import('../lib/scriptedTurn.ts')

const ROOT = resolve(import.meta.dir, '..', '..')
const WIN = process.platform === 'win32'
const KEEP = process.argv.includes('--keep')
const ONE_GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024
const SPARSE_REAL_BYTES_MOST = 64 * MIB
const RUNAWAY_BYTES = ONE_GIB

let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`

const world = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'seen-lines-regular-')))
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
delete sceneEnv.MERCURY_EDIT_HUNKS
delete sceneEnv.NODE_ENV
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

type SceneRun = { returned: boolean; value: Record<string, unknown>; ms: number; peak: number; cut: 'deadline' | 'memory' | null; stderr: string }

async function scene(name: string, args: SceneArgs, limits: { deadlineMs: number; runaway?: boolean }): Promise<SceneRun> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, import.meta.path, '--scene', name, JSON.stringify(args)], { env: sceneEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let cut: SceneRun['cut'] = null
  const deadline = setTimeout(() => {
    cut = cut ?? 'deadline'
    proc.kill('SIGKILL')
  }, limits.deadlineMs)
  const watch = limits.runaway === true
    ? setInterval(() => {
        if (residentBytesOf(proc.pid) <= RUNAWAY_BYTES) return
        cut = cut ?? 'memory'
        proc.kill('SIGKILL')
      }, 100)
    : null
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(deadline)
  if (watch !== null) clearInterval(watch)
  const line = stdout.split('\n').find(l => l.startsWith('SCENE '))
  return { returned: line !== undefined, value: line === undefined ? {} : (JSON.parse(line.slice(6)) as Record<string, unknown>), ms: Date.now() - started, peak: Number(proc.resourceUsage()?.maxRSS ?? 0), cut, stderr }
}
const how = (run: SceneRun): string =>
  run.returned ? `${j(run.value)} in ${run.ms} ms` : run.cut === 'memory' ? `killed after ${run.ms} ms: its resident memory passed ${mib(RUNAWAY_BYTES)}` : run.cut === 'deadline' ? `no answer in ${run.ms} ms: killed at the deadline` : `it ended without an answer: ${run.stderr.slice(-300)}`

function sparse(path: string, head: string, bytes: number): boolean {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, head)
    ftruncateSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
  return statSync(path).blocks * 512 <= SPARSE_REAL_BYTES_MOST
}
function namedPipe(path: string): boolean {
  return spawnSync('mkfifo', [path]).status === 0
}
const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 12)
function asTheParentComputedIt(path: string): string {
  const st = statSync(path)
  return `m${Math.floor(st.mtimeMs)}:${st.size}:${digestOf(readFileSync(path))}`
}

const reportLines = Array.from({ length: 12 }, (_, i) => `line ${i + 1} of the report`)
const reportText = reportLines.join('\n') + '\n'
const shownReport = reportLines.map((line, i) => `${i + 1}\t${line}`).join('\n')
const logHead = Array.from({ length: 200 }, (_, i) => `line ${String(i + 1).padStart(4, '0')} of the log`).join('\n') + '\n'

section('§1 a regular file reads as it did: the generation is the stat and the digest of its bytes, whatever its size under the bound')
const textPath = join(files, 'report.md')
const emptyPath = join(files, 'empty.txt')
const linkPath = join(files, 'report-link.md')
const midPath = join(files, 'mid.log')
const folderPath = join(files, 'a-folder')
const missingPath = join(files, 'never-written.txt')
writeFileSync(textPath, reportText)
writeFileSync(emptyPath, '')
symlinkSync(textPath, linkPath)
sparse(midPath, logHead, 16 * MIB)
mkdirSync(folderPath)
let ledgerBound: number | null = null
let controlPeak = 0
{
  const run = await scene('parity', { paths: { text: textPath, empty: emptyPath, link: linkPath, mid: midPath, folder: folderPath, missing: missingPath } }, { deadlineMs: bound(60_000) })
  const generations = (run.value.generations ?? {}) as Record<string, string | null>
  ledgerBound = typeof run.value.bound === 'number' ? run.value.bound : null
  controlPeak = run.peak
  check('the scene answered', run.returned, how(run))
  check('a text file: the generation the parent computed', generations.text === asTheParentComputedIt(textPath), `${String(generations.text)} vs ${asTheParentComputedIt(textPath)}`)
  check('an empty file: its stat and the digest of no bytes', generations.empty === asTheParentComputedIt(emptyPath) && String(generations.empty).endsWith(':0:e3b0c44298fc'), String(generations.empty))
  check('a link to a file: the generation of the file it names', generations.link === asTheParentComputedIt(textPath), String(generations.link))
  check('a file of 16 MiB: read whole, the same generation', generations.mid === asTheParentComputedIt(midPath), `${String(generations.mid)} vs ${asTheParentComputedIt(midPath)}`)
  check('a folder and a path that is not there have no generation', generations.folder === null && generations.missing === null, j(generations))
  check('the bytes just written: the generation when the file holds exactly them, none when one byte or the length differs', run.value.writtenSame === asTheParentComputedIt(textPath) && run.value.writtenOtherBytes === null && run.value.writtenOtherLength === null, j([run.value.writtenSame, run.value.writtenOtherBytes, run.value.writtenOtherLength]))
}

section('§2 what is not a regular file is never opened: a pipe nobody writes to and a device answer "no generation" at once')
const pipePath = join(files, 'pipe.log')
const pipeLinkPath = join(files, 'pipe-link.log')
const havePipe = !WIN && namedPipe(pipePath)
if (!havePipe) {
  console.log('  [SKIP] no named pipe on this platform')
} else {
  symlinkSync(pipePath, pipeLinkPath)
  const direct = await scene('generation', { path: pipePath }, { deadlineMs: bound(15_000) })
  check('a named pipe: no generation, and the call returns', direct.returned && direct.value.generation === null, how(direct))
  const linked = await scene('generation', { path: pipeLinkPath }, { deadlineMs: bound(15_000) })
  check('a link to a named pipe: the same', linked.returned && linked.value.generation === null, how(linked))
  const written = await scene('written', { path: pipePath, text: '' }, { deadlineMs: bound(15_000) })
  check('the written-bytes reader on a named pipe: no generation, and the call returns', written.returned && written.value.generation === null, how(written))
}
if (WIN || !existsSync('/dev/zero')) {
  console.log('  [SKIP] no /dev/zero on this platform')
} else {
  const device = await scene('generation', { path: '/dev/zero' }, { deadlineMs: bound(15_000), runaway: true })
  check('a device that never ends: no generation, and no byte of it read into memory', device.returned && device.value.generation === null, how(device))
}

section('§3 a file over the bound is never read: the bound is the largest file the Edit door takes, so no file an edit can change loses its generation')
const overPath = join(files, 'over.log')
{
  const editDoor = readFileSync(join(ROOT, 'src/tools/FileEditTool/FileEditTool.ts'), 'utf8')
  const { CHANGESET_BOUNDS } = await import('../../src/services/changeTransaction/changeSetContracts.ts')
  check('the bound is 1 GiB: the size above which the Edit door refuses a file before any other check', ledgerBound === ONE_GIB && editDoor.includes('const ONE_GIB = 1024 * 1024 * 1024') && editDoor.includes('if (stats.size > ONE_GIB) {'), `bound ${String(ledgerBound)}`)
  check('the ChangeSet door stages far less than the bound, so its files keep their generation too', ledgerBound !== null && CHANGESET_BOUNDS.maxStagedBytes < ledgerBound, `${CHANGESET_BOUNDS.maxStagedBytes} vs ${String(ledgerBound)}`)
}
const haveOver = !WIN && sparse(overPath, logHead, ONE_GIB + 1)
if (!haveOver) {
  console.log('  [SKIP] this filesystem did not make a sparse file: the over-the-bound scenes are not run')
  rmSync(overPath, { force: true })
} else {
  const over = await scene('generation', { path: overPath }, { deadlineMs: bound(60_000) })
  check('a file one byte over the bound: no generation', over.returned && over.value.generation === null, how(over))
  console.log(`  peak resident memory of the call: ${mib(over.peak)} on the file over the bound, ${mib(controlPeak)} on small files`)
  check("…and it was not read: the call's peak resident memory stays under twice a small file's", over.returned && controlPeak > 0 && over.peak < 2 * controlPeak, `${mib(over.peak)} against ${mib(controlPeak)}`)
}

section('§4 the ledger rebuilt from a transcript: a path that is no longer a regular file under the bound is not seen, and the edit doors then ask for a Read')
{
  const intact = await scene('rebuild', { path: textPath, shown: shownReport }, { deadlineMs: bound(30_000) })
  check('the file as it was read: its twelve shown lines count as read again', intact.returned && j(intact.value.summary) === j({ files: 1, lines: 12 }) && intact.value.ok === true, how(intact))
}
if (havePipe) {
  const piped = await scene('rebuild', { path: pipePath, shown: shownReport }, { deadlineMs: bound(15_000) })
  check('the path is a named pipe now: the rebuild returns and credits nothing', piped.returned && j(piped.value.summary) === j({ files: 0, lines: 0 }) && piped.value.ranges === null, how(piped))
  check('…so a check of its first line fails toward a Read', piped.returned && piped.value.ok === false && String(piped.value.hint).includes('were never displayed this session'), how(piped))
  const refused = await scene('knowledge', { path: pipePath, text: reportText }, { deadlineMs: bound(30_000) })
  check('the Edit door on a path that is a named pipe: it has no generation to go by, refuses and asks for a Read', refused.returned && String(refused.value.refusal).startsWith('Read the file before editing it') && String(refused.value.refusal).includes('the current generation could not be read'), how(refused))
}
if (haveOver) {
  const shownLog = logHead.split('\n').slice(0, 12).map((line, i) => `${i + 1}\t${line}`).join('\n')
  const grown = await scene('rebuild', { path: overPath, shown: shownLog }, { deadlineMs: bound(60_000) })
  check('the path is over the bound now, its first lines unchanged: the rebuild credits nothing', grown.returned && j(grown.value.summary) === j({ files: 0, lines: 0 }) && grown.value.ranges === null && grown.value.ok === false, how(grown))
  const refused = await scene('knowledge', { path: overPath, text: logHead }, { deadlineMs: bound(60_000) })
  check('the Edit door on a path over the bound: it has no generation to go by, refuses and asks for a Read', refused.returned && String(refused.value.refusal).startsWith('Read the file before editing it') && String(refused.value.refusal).includes('the current generation could not be read'), how(refused))
}

section('§5 the built product: a run that reads twenty lines of a 2 GB log, and a resume of it, cost what they cost on a small log')
type BundleRun = { code: number | null; outcome: Record<string, unknown> | null; peak: number; ms: number; cut: boolean; stderr: string }
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
  return { code, outcome, peak: Number(proc.resourceUsage()?.maxRSS ?? 0), ms: Date.now() - started, cut, stderr }
}
const READ_ASK = 'read the first twenty lines of the log'
const RESUME_ASK = 'go on from there'
const completed = (run: BundleRun): boolean => !run.cut && run.code === 0 && run.outcome?.status === 'completed'
const told = (run: BundleRun): string => (run.cut ? `no end in ${run.ms} ms: killed at the deadline` : `exit ${String(run.code)} · ${String(run.outcome?.status)} · ${mib(run.peak)} · ${run.stderr.slice(-200)}`)

if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
} else if (WIN) {
  console.log('  [SKIP] the sparse-file scenes are not run on this platform')
} else {
  console.log(`build under proof: ${DIST}`)
  const play = async (label: string, logBytes: number): Promise<{ run: BundleRun; resume: BundleRun; resumeRequests: number; logPath: string; session: string; cwd: string; env: NodeJS.ProcessEnv; base: string; close: () => Promise<void>; requests: () => number } | null> => {
    const home = join(world, label, 'home')
    const cwd = join(world, label, 'work')
    seedScratchHome(home, cwd)
    const logPath = join(cwd, 'build.log')
    if (!sparse(logPath, logHead, logBytes)) return null
    const fixture = await startScriptedFixture(req => {
      if (req.ask.trim() === READ_ASK && req.step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: logPath, offset: 1, limit: 20 } }]
      return [{ type: 'text', text: req.ask.trim() === RESUME_ASK ? 'resumed' : 'read' }]
    })
    const env = childEnv(home, Number(new URL(fixture.base).port))
    const session = randomUUID()
    const run = await mercury(['run', READ_ASK, '--format', 'json', '--mode', 'sovereign', '--model', MODEL, '--session-id', session], cwd, env, bound(120_000))
    const resume = await mercury(['run', RESUME_ASK, '--format', 'json', '--mode', 'sovereign', '--model', MODEL, '--resume', session], cwd, env, bound(120_000))
    const requests = (): number => fixture.requests.filter(r => r.ask.trim() === RESUME_ASK).length
    return { run, resume, resumeRequests: requests(), logPath, session, cwd, env, base: fixture.base, close: fixture.close, requests }
  }
  const small = await play('small', logHead.length)
  const big = await play('big', 2_000_000_000)
  if (small === null || big === null) {
    console.log('  [SKIP] this filesystem did not make a sparse file: the 2 GB scenes are not run')
  } else {
    const shownToTheModel = (played: NonNullable<typeof small>): boolean => played.run.outcome?.steps === 2
    check('the small log: the run completes in two model calls and its resume in one', completed(small.run) && shownToTheModel(small) && completed(small.resume) && small.resumeRequests === 1, `${told(small.run)} · ${told(small.resume)} · ${small.resumeRequests} request(s)`)
    check('the 2 GB log: the run completes in two model calls and its resume in one', completed(big.run) && shownToTheModel(big) && completed(big.resume) && big.resumeRequests === 1, `${told(big.run)} · ${told(big.resume)} · ${big.resumeRequests} request(s)`)
    console.log(`  peak resident memory: the run ${mib(big.run.peak)} on the 2 GB log, ${mib(small.run.peak)} on the small one; the resume ${mib(big.resume.peak)}, ${mib(small.resume.peak)}`)
    check("the Read of twenty lines of the 2 GB log does not take the file into memory: the run's peak stays under twice the small log's", small.run.peak > 0 && big.run.peak < 2 * small.run.peak, `${mib(big.run.peak)} against ${mib(small.run.peak)}`)
    check("the resume does not take it into memory either: its peak stays under twice the small log's", small.resume.peak > 0 && big.resume.peak < 2 * small.resume.peak, `${mib(big.resume.peak)} against ${mib(small.resume.peak)}`)
    const grew = sparse(small.logPath, logHead, 2_000_000_000)
    const again = await mercury(['run', RESUME_ASK, '--format', 'json', '--mode', 'sovereign', '--model', MODEL, '--resume', small.session], small.cwd, small.env, bound(120_000))
    check('the small log grown to 2 GB since it was read: a resume of that session completes with one more model call', grew && completed(again) && small.requests() === 2, `${told(again)} · ${small.requests()} request(s)`)
    console.log(`  peak resident memory of that resume: ${mib(again.peak)}`)
    check("…and its peak stays under twice the first resume's", again.peak < 2 * small.resume.peak, `${mib(again.peak)} against ${mib(small.resume.peak)}`)
  }
  if (small !== null) await small.close()
  if (big !== null) await big.close()
}

if (failures === 0 && !KEEP) rmSync(world, { recursive: true, force: true })
else console.log(`\nworld kept: ${world}`)
console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('SEEN LINES REGULAR FILES RED')
  process.exit(1)
}
console.log('SEEN LINES REGULAR FILES GREEN')
