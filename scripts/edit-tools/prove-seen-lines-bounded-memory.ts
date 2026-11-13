#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { closeSync, createReadStream, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

type Step = { path: string; shown?: string; written?: string; error?: boolean; id?: string }
type SceneArgs = { path?: string; paths?: string[]; steps?: Step[]; excluded?: string[] }
type Seen = { generation: string; ranges: Array<{ start: number; end: number }> } | null
type Cut = { line: number; visibleChars: number }

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
  if (name === 'generations') return say({ generations: (args.paths ?? []).map(path => ledger.fileGeneration(path)) })
  if (name === 'generation') return say({ generation: ledger.fileGeneration(args.path!) })
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
  const owner = processMainOwner()
  const rows: unknown[] = []
  let ids = 0
  for (const step of args.steps ?? []) {
    const id = step.id ?? `call_${++ids}`
    rows.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: step.written === undefined ? 'Read' : 'Write', input: { file_path: step.path, ...(step.written === undefined ? {} : { content: step.written }) } }] } })
    rows.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: step.shown ?? 'written', ...(step.error === true ? { is_error: true } : {}) }] } })
  }
  const summary = ledger.rebuildSeenLinesFromTranscript(owner, rows, args.excluded === undefined ? undefined : new Set(args.excluded))
  const paths = [...new Set((args.steps ?? []).map(step => step.path))]
  say({
    summary,
    seen: paths.map(path => {
      const seen = ledger.seenLinesOf(owner, path)
      return { path, seen: seen ?? null, cuts: seen === undefined ? [] : ledger.columnCutsOf(owner, path, seen.generation) }
    }),
  })
}

const { bound, SCRATCH_ROOT } = await import('../daemon/dupline-world.ts')

const KEEP = process.argv.includes('--keep')
const MIB = 1024 * 1024
const LOG_BYTES = 900 * 1000 * 1000
const SPARSE_REAL_BYTES_MOST = 64 * MIB

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
const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`

const world = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'seen-lines-bounded-')))
const files = join(world, 'files')
mkdirSync(files, { recursive: true })
mkdirSync(join(world, 'scene-home'), { recursive: true })
console.log(`world: ${world}`)
const p = (name: string): string => join(files, name)

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

type SceneRun = { returned: boolean; value: Record<string, unknown>; ms: number; peak: number; stderr: string }
async function scene(name: string, args: SceneArgs, deadlineMs: number): Promise<SceneRun> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, import.meta.path, '--scene', name, JSON.stringify(args)], { env: sceneEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const deadline = setTimeout(() => proc.kill('SIGKILL'), deadlineMs)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(deadline)
  const line = stdout.split('\n').find(l => l.startsWith('SCENE '))
  return { returned: line !== undefined, value: line === undefined ? {} : (JSON.parse(line.slice(6)) as Record<string, unknown>), ms: Date.now() - started, peak: Number(proc.resourceUsage()?.maxRSS ?? 0), stderr }
}
const how = (run: SceneRun): string => (run.returned ? `${j(run.value).slice(0, 500)} in ${run.ms} ms` : `no answer in ${run.ms} ms · ${run.stderr.slice(-300)}`)

async function generationByAStream(path: string): Promise<string> {
  const st = statSync(path)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return `m${Math.floor(st.mtimeMs)}:${st.size}:${hash.digest('hex').slice(0, 12)}`
}
function patterned(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251
  return bytes
}
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

const logLine = (n: number): string => `line ${String(n).padStart(4, '0')} of the log, with words after it`
const logHead = Array.from({ length: 200 }, (_, i) => logLine(i + 1)).join('\n') + '\n'
const logPath = p('grown.log')
const haveLog = process.platform !== 'win32' && sparse(logPath, logHead, LOG_BYTES)

section('§1 the generation of a file is its stat and the digest of its bytes, the same value at every size')
const sizes: Array<[string, number]> = [['no byte', 0], ['one byte', 1], ['a chunk less one byte', MIB - 1], ['exactly a chunk', MIB], ['a chunk and one byte', MIB + 1], ['two chunks and three bytes', 2 * MIB + 3]]
for (const [, size] of sizes) writeFileSync(p(`size-${size}`), patterned(size))
let controlPeak = 0
{
  const run = await scene('generations', { paths: sizes.map(([, size]) => p(`size-${size}`)) }, bound(60_000))
  const got = (run.value.generations ?? []) as Array<string | null>
  controlPeak = run.peak
  for (const [at, [label, size]] of sizes.entries()) {
    const expected = await generationByAStream(p(`size-${size}`))
    check(`a file of ${label}: the stat and the first twelve hex of the SHA-256 of its bytes`, run.returned && got[at] === expected, `${String(got[at])} against ${expected}`)
  }
}
let logGeneration = ''
if (!haveLog) {
  console.log('  [SKIP] this filesystem did not make a sparse file: the 900 MB scenes are not run')
} else {
  logGeneration = await generationByAStream(logPath)
  const run = await scene('generation', { path: logPath }, bound(120_000))
  console.log(`  the generation of the 900 MB log: ${run.ms} ms, peak resident memory ${mib(run.peak)}; of the six small files together ${mib(controlPeak)}`)
  check('a log of 900 MB: the same rule, the same value', run.returned && run.value.generation === logGeneration, `${how(run)} against ${logGeneration}`)

  section('§2 the digest is taken in bounded memory: the file is not read whole to hash it')
  check("the call's peak resident memory on the 900 MB log stays under twice that of the small files", run.returned && controlPeak > 0 && run.peak < 2 * controlPeak, `${mib(run.peak)} against ${mib(controlPeak)}`)
}

section('§3 a resume takes from each file the lines its transcript shows, and nothing else of the file into memory')
if (haveLog) {
  const shown = Array.from({ length: 20 }, (_, i) => `${i + 1}\t${logLine(i + 1)}`).join('\n')
  const run = await scene('rebuild', { steps: [{ path: logPath, shown }] }, bound(120_000))
  const seen = ((run.value.seen ?? []) as Array<{ seen: Seen }>)[0]?.seen ?? null
  console.log(`  the rebuild of twenty shown lines of the 900 MB log: ${run.ms} ms, peak resident memory ${mib(run.peak)}`)
  check('the twenty lines the transcript shows are credited, under the generation of the file as it stands', run.returned && seen !== null && seen.generation === logGeneration && j(seen.ranges) === j([{ start: 1, end: 20 }]) && j(run.value.summary) === j({ files: 1, lines: 20 }), how(run))
  check("the rebuild's peak resident memory stays under twice that of the small files", run.returned && controlPeak > 0 && run.peak < 2 * controlPeak, `${mib(run.peak)} against ${mib(controlPeak)}`)
}

section('§4 the lines a resume credits are the lines a reading of the whole file credits')
{
  const TRUNCATED_TAIL = /… \[truncated \d+ characters\]$/
  const NUMBERED = /^(\d+)(?:#[0-9a-f]+)?\t([\s\S]*)$/
  function byAWholeReading(path: string, steps: Step[], excluded: string[]): { lines: number[]; cuts: Cut[]; credited: number } | null {
    let text: string
    try {
      if (!statSync(path).isFile()) return null
      text = readFileSync(path).toString('utf8')
    } catch {
      return null
    }
    const lines = text.split('\n')
    const credited = new Set<number>()
    const cuts = new Map<number, number>()
    let counted = 0
    for (const step of steps) {
      if (step.path !== path || step.error === true || (step.id !== undefined && excluded.includes(step.id))) continue
      if (step.written !== undefined) {
        if (text !== step.written) continue
        const whole = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
        for (let n = 1; n <= whole; n++) credited.add(n)
        counted += lines.length
        continue
      }
      const shown = new Map<number, string>()
      for (const row of (step.shown ?? '').split('\n')) {
        const match = NUMBERED.exec(row)
        if (match !== null) shown.set(Number(match[1]), match[2]!)
      }
      for (const [n, body] of shown) {
        if (n < 1 || n > lines.length) continue
        if (TRUNCATED_TAIL.test(body)) {
          const prefix = body.replace(TRUNCATED_TAIL, '')
          if (lines[n - 1]!.startsWith(prefix) && lines[n - 1]!.length > prefix.length) cuts.set(n, prefix.length)
          continue
        }
        if (lines[n - 1] !== body) continue
        credited.add(n)
        cuts.delete(n)
        counted++
      }
    }
    return { lines: [...credited].sort((a, b) => a - b), cuts: [...cuts].map(([line, visibleChars]) => ({ line, visibleChars })).sort((a, b) => a.line - b.line), credited: counted }
  }
  const text = (name: string, content: string | Buffer): string => {
    writeFileSync(p(name), content)
    return p(name)
  }
  const line = (n: number): string => `line ${n} of the fixture, with words after it`
  const lf = text('lf.txt', Array.from({ length: 30 }, (_, i) => line(i + 1)).join('\n') + '\n')
  const crlf = text('crlf.txt', Array.from({ length: 8 }, (_, i) => line(i + 1)).join('\r\n') + '\r\n')
  const bom = text('bom.txt', '\uFEFF' + Array.from({ length: 5 }, (_, i) => line(i + 1)).join('\n') + '\n')
  const open = text('no-final-newline.txt', Array.from({ length: 4 }, (_, i) => line(i + 1)).join('\n'))
  const empty = text('empty.txt', '')
  const long = text('long-line.txt', `${'y'.repeat(9000)}\nshort second line\n${'é'.repeat(5000)}\n`)
  const invalid = text('invalid-utf8.txt', Buffer.concat([Buffer.from('good line\nbad '), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from(' tail\nlast\n')]))
  const kept = text('written-kept.txt', 'the content a Write left\nsecond line é\n')
  const grown = text('written-grown.txt', 'something else stands here now, and it is longer than what was written\n')
  const shrunk = text('written-shrunk.txt', 'short\n')
  const straddle = text('straddle.txt', Buffer.concat([Buffer.alloc(MIB - 2, 0x61), Buffer.from('éé\nthe line after the boundary é\nand the next\n')]))
  const edge = text('newline-at-the-boundary.txt', Buffer.concat([Buffer.alloc(MIB - 1, 0x62), Buffer.from('\nthe line right after a newline at the boundary\nand one more\n')]))
  const rows = (pairs: Array<[number, string]>): string => pairs.map(([n, body]) => `${n}\t${body}`).join('\n')
  const cases: Array<{ name: string; steps: Step[]; excluded?: string[] }> = [
    { name: 'five lines of a text file', steps: [{ path: lf, shown: rows([1, 2, 3, 4, 5].map(n => [n, line(n)])) }] },
    { name: 'a line shown with its anchor, and a line the file no longer holds', steps: [{ path: lf, shown: `7#ab3f\t${line(7)}\n8\tnot what the file holds\n9\t${line(9)}` }] },
    { name: 'line numbers past the end, a zero, the empty piece after the last newline', steps: [{ path: lf, shown: rows([[0, 'x'], [30, line(30)], [31, ''], [32, ''], [9000000, 'x']]) }] },
    { name: 'the same file shown twice, overlapping', steps: [{ path: lf, shown: rows([[1, line(1)], [2, line(2)]]) }, { path: lf, shown: rows([[2, line(2)], [3, line(3)]]) }] },
    { name: 'CRLF lines, shown with and without the carriage return', steps: [{ path: crlf, shown: rows([[1, `${line(1)}\r`], [2, line(2)], [8, `${line(8)}\r`], [9, '']]) }] },
    { name: 'a BOM, shown with and without it', steps: [{ path: bom, shown: rows([[1, `\uFEFF${line(1)}`], [2, line(2)]]) }, { path: bom, shown: rows([[1, line(1)]]) }] },
    { name: 'a file with no final newline', steps: [{ path: open, shown: rows([[4, line(4)], [5, '']]) }] },
    { name: 'an empty file', steps: [{ path: empty, shown: rows([[1, ''], [2, '']]) }] },
    { name: 'clipped lines: one longer than what was shown, one not longer, one that does not match, one of two-byte characters', steps: [{ path: long, shown: rows([[1, `${'y'.repeat(2000)}… [truncated 7000 characters]`], [2, 'short second line… [truncated 3 characters]'], [3, `${'é'.repeat(1999)}x… [truncated 3000 characters]`]]) }, { path: long, shown: rows([[3, `${'é'.repeat(2000)}… [truncated 3000 characters]`], [1, 'y'.repeat(8999)]]) }] },
    { name: 'a long line shown clipped and then whole', steps: [{ path: long, shown: rows([[1, `${'y'.repeat(2000)}… [truncated 7000 characters]`]]) }, { path: long, shown: rows([[1, 'y'.repeat(9000)], [2, 'short second line']]) }] },
    { name: 'bytes that are not UTF-8, shown as the three marks they decode to', steps: [{ path: invalid, shown: rows([[1, 'good line'], [2, 'bad \uFFFD\uFFFD\uFFFD tail'], [3, 'last']]) }] },
    { name: 'bytes that are not UTF-8, shown as something else', steps: [{ path: invalid, shown: rows([[2, 'bad \uFFFD tail']]) }] },
    { name: 'a Write whose content still stands, then a Read of it', steps: [{ path: kept, written: 'the content a Write left\nsecond line é\n' }, { path: kept, shown: rows([[2, 'second line é']]) }] },
    { name: 'a Write whose file now holds something longer', steps: [{ path: grown, written: 'what was written\n' }] },
    { name: 'a Write whose file now holds something shorter', steps: [{ path: shrunk, written: 'short\nand a second line that is gone\n' }] },
    { name: 'a two-byte character cut by the chunk boundary', steps: [{ path: straddle, shown: rows([[1, `${'a'.repeat(2000)}… [truncated 1046000 characters]`], [2, 'the line after the boundary é'], [3, 'and the next']]) }] },
    { name: 'a newline that is the last byte of a chunk', steps: [{ path: edge, shown: rows([[2, 'the line right after a newline at the boundary'], [3, 'and one more'], [4, '']]) }] },
    { name: 'an error result and an excluded result credit nothing', steps: [{ path: lf, shown: rows([[1, line(1)]]), error: true }, { path: lf, shown: rows([[2, line(2)]]), id: 'call_excluded' }, { path: lf, shown: rows([[3, line(3)]]) }], excluded: ['call_excluded'] },
    { name: 'a folder and a path that is not there credit nothing', steps: [{ path: files, shown: rows([[1, 'x']]) }, { path: p('never-there.txt'), shown: rows([[1, 'x']]) }] },
  ]
  for (const item of cases) {
    const run = await scene('rebuild', { steps: item.steps, excluded: item.excluded }, bound(60_000))
    const got = (run.value.seen ?? []) as Array<{ path: string; seen: Seen; cuts: Cut[] }>
    const wrong: string[] = []
    let expectedCount = 0
    for (const entry of got) {
      const expected = byAWholeReading(entry.path, item.steps, item.excluded ?? [])
      const lines = entry.seen === null ? [] : entry.seen.ranges.flatMap(range => Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i))
      const cuts = [...(entry.cuts ?? [])].sort((a, b) => a.line - b.line)
      expectedCount += expected?.credited ?? 0
      if (j(lines) !== j(expected?.lines ?? []) || j(cuts) !== j(expected?.cuts ?? [])) wrong.push(`${entry.path.slice(files.length + 1)}: lines ${j(lines)} cuts ${j(cuts)} against lines ${j(expected?.lines ?? [])} cuts ${j(expected?.cuts ?? [])}`)
    }
    const summary = run.value.summary as { lines?: number } | undefined
    check(`${item.name}`, run.returned && wrong.length === 0 && summary?.lines === expectedCount, `${wrong.join(' | ')} · counted ${String(summary?.lines)} against ${expectedCount} · ${run.stderr.slice(-200)}`)
  }
}

if (failures === 0 && !KEEP) rmSync(world, { recursive: true, force: true })
else console.log(`\nworld kept: ${world}`)
console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('SEEN LINES BOUNDED MEMORY RED')
  process.exit(1)
}
console.log('SEEN LINES BOUNDED MEMORY GREEN')
