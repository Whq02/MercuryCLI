import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cpus, release } from 'node:os'
import { recordPty, decodePtyRecording, sharedClockMs, outputBursts, type PtyRecord } from '../lib/ptyRecorder.ts'
import { buildScene } from './build-scene.ts'
import { costRows, fiveRunMedians, timingNoise } from './cost-comparison.ts'
import { BASE, ROOT, argument, baseSources, git, hasBaseObject, median, scratch } from './support.ts'

type Frame = { atMs: number; view: string; draft: string; durationMs: number; phases?: { patches: number; renderer: number; diff: number; optimize: number; write: number; yoga: number; commit: number } }
type Input = { atMs: number; kind: 'key' | 'view' | 'pointer' }
type Metrics = Record<string, number>
const scenes = join(import.meta.dir, 'scenes')
const work = argument('--work-dir') ?? scratch('frame-cost-')
mkdirSync(work, { recursive: true })
const readFrames = (path: string): Frame[] => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = sharedClockMs() + 30_000
  while (!predicate()) {
    if (sharedClockMs() > end) throw new Error(`no ${label} frame mark within 30 seconds`)
    await delay(5)
  }
}
function outputBetween(records: PtyRecord[], start: number, end: number): PtyRecord[] {
  return records.filter(row => row.direction === 'output' && row.atMs >= start && row.atMs < end)
}
const bytesOf = (rows: readonly PtyRecord[]): number => rows.reduce((sum, row) => sum + row.bytes.length, 0)
async function measure(bundle: string, label: string): Promise<{ metrics: Metrics; frames: number; inputs: number }> {
  const dir = join(work, label)
  mkdirSync(dir, { recursive: true })
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const timing = join(dir, 'frames.jsonl')
  const raw = join(dir, 'pty.bin')
  writeFileSync(timing, '')
  const env: Record<string, string | undefined> = {
    ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file',
    TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', COLORTERM: 'truecolor', FORCE_COLOR: '3', COLORFGBG: '15;0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_CRITTER_SLEEP: '0',
  }
  for (const key of ['MERCURY_HOME', 'MERCURY_CRITTER', 'CI', 'NO_COLOR', 'TMUX', 'WT_SESSION']) delete env[key]
  const recording = recordPty({ argv: [join(ROOT, 'dist/vendor/node/bin/node'), bundle, scenes, timing], cwd: ROOT, env, cols: 177, rows: 49, path: raw })
  const inputs: Input[] = []
  try {
    await until(() => readFrames(timing).some(frame => frame.view === 'boot'), 'boot')
    recording.send('\r')
    await until(() => readFrames(timing).some(frame => frame.view === 'chat'), 'chat')
    await delay(250)
    const idleStart = sharedClockMs()
    await delay(10_000)
    const idleEnd = sharedClockMs()
    for (const key of 'the quick brown fox!') {
      inputs.push({ atMs: recording.send(key), kind: 'key' })
      await delay(120)
    }
    for (let turn = 0; turn < 6; turn++) {
      inputs.push({ atMs: recording.send(turn % 2 === 0 ? '\x1b[1;2D' : '\x1b[1;2C'), kind: 'view' })
      await delay(1500)
    }
    for (const row of [2, 30]) {
      inputs.push({ atMs: recording.send(`\x1b[<35;40;${row}M`), kind: 'pointer' })
      await delay(150)
    }
    const ended = sharedClockMs()
    const frames = readFrames(timing)
    assert.equal(frames.at(-1)?.draft, 'the quick brown fox!', 'typed draft survives the switches and pointer reports')
    const rows = inputs.map((input, index) => {
      const end = inputs[index + 1]?.atMs ?? ended
      const output = outputBetween(recording.records, input.atMs, end)
      const burst = outputBursts(output)[0] ?? []
      const active = frames.filter(frame => frame.atMs >= input.atMs && frame.atMs < end && (frame.phases?.patches ?? 0) > 0)
      if (input.kind === 'view') assert.ok(output.length > 0, `${label} missing repaint for view switch ${index}`)
      if (input.kind !== 'pointer' && output.length > 0) assert.ok(active.length > 0, `${label} missing engine timing for input ${index}`)
      return {
        kind: input.kind, silent: output.length === 0, bytes: bytesOf(output), firstMs: output[0] ? output[0].atMs - input.atMs : 0,
        burstEndMs: burst.at(-1) ? burst.at(-1)!.atMs - input.atMs : 0,
        lastMs: output.at(-1) ? output.at(-1)!.atMs - input.atMs : 0,
        engineMs: active.length ? Math.max(...active.map(frame => frame.durationMs)) : 0,
        layoutMs: active.length ? Math.max(...active.map(frame => frame.phases?.yoga ?? 0)) : 0,
        composeMs: active.length ? Math.max(...active.map(frame => frame.phases?.renderer ?? 0)) : 0,
      }
    })
    const keys = rows.filter(row => row.kind === 'key' && !row.silent)
    const views = rows.filter(row => row.kind === 'view')
    const pointers = rows.filter(row => row.kind === 'pointer')
    const silentKeys = rows.flatMap((row, index) => row.kind === 'key' && row.silent ? [index] : [])
    assert.ok(keys.length >= 10, `${label} echoed only ${keys.length} of 20 keys`)
    const metrics: Metrics = {
      keyBytes: median(keys.map(row => row.bytes)),
      keyFirstMs: median(keys.map(row => row.firstMs)),
      keyFirstMaxMs: Math.max(...keys.map(row => row.firstMs)),
      keyBurstEndMs: median(keys.map(row => row.burstEndMs)),
      keyLastMs: median(keys.map(row => row.lastMs)),
      viewBytes: median(views.map(row => row.bytes)),
      viewFirstMs: median(views.map(row => row.firstMs)),
      viewBurstEndMs: median(views.map(row => row.burstEndMs)),
      viewLastMs: median(views.map(row => row.lastMs)),
      idleBytesPer10s: bytesOf(outputBetween(recording.records, idleStart, idleEnd)),
      pointerBytes: median(pointers.map(row => row.bytes)),
      fullFrameMs: median(views.map(row => row.engineMs)),
      smallFrameMs: median(keys.map(row => row.engineMs)),
      fullLayoutMs: median(views.map(row => row.layoutMs)),
      fullComposeMs: median(views.map(row => row.composeMs)),
    }
    writeFileSync(join(dir, 'measurements.json'), JSON.stringify({ metrics, silentKeys, inputs, rows, idleStart, idleEnd, ended }, null, 2) + '\n')
    const decoded = decodePtyRecording(readFileSync(raw))
    assert.deepEqual(decoded, recording.records, 'raw recorder round trips every byte and timestamp')
    recording.send('\x03')
    await until(() => readFrames(timing).length >= frames.length, 'final')
    return { metrics, silentKeys, frames: frames.length, inputs: inputs.length }
  } finally {
    await recording.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const baselinePath = join(import.meta.dir, `baseline-${BASE.slice(0, 9)}.json`)
const liveBase = hasBaseObject()
const recordingBase = process.argv.includes('--record-base')
assert.ok(liveBase || existsSync(baselinePath), 'neither the pinned base git object nor its committed measurement record is available')
if (recordingBase) {
  assert.ok(liveBase, 'the base object is required to record measurements')
  assert.ok(!existsSync(baselinePath), 'the base measurement record is write-once')
  assert.equal(git('diff', BASE, '--', 'src', 'assets'), '', 'the first baseline must precede engine changes')
} else assert.ok(existsSync(baselinePath), 'write-once base record is missing')
const recorded = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) as { baseSha: string; sceneDigest: string; silentKeys: number[]; medians: Metrics; runs: Array<{ metrics: Metrics; silentKeys: number[] }> } : null
const baseBundle = liveBase ? await buildScene(baseSources(work), join(work, 'base-dist')) : null
const tipBundle = await buildScene(ROOT, join(work, 'tip-dist'))
const runs: { base: Awaited<ReturnType<typeof measure>>[]; tip: Awaited<ReturnType<typeof measure>>[] } = { base: [], tip: [] }
for (let round = 0; round < 5; round++) {
  const sides: Array<'base' | 'tip'> = !liveBase ? ['tip'] : round % 2 ? ['tip', 'base'] : ['base', 'tip']
  for (const side of sides) {
    const reading = await measure(side === 'base' ? baseBundle! : tipBundle, `${side}-${round + 1}`)
    runs[side].push(reading)
    console.log(`[MEASURED] ${side} ${round + 1}/5 ${JSON.stringify(reading.metrics)}`)
  }
}
const base = liveBase ? fiveRunMedians(runs.base) : recorded!.medians
const tip = fiveRunMedians(runs.tip)
const silentKeys = (recorded ?? runs.base[0] ?? runs.tip[0])!.silentKeys
for (const run of [...runs.base, ...runs.tip, ...(recorded?.runs ?? [])]) assert.deepEqual(run.silentKeys, silentKeys, 'every run of the same scene must leave the same keys without bytes')
const digest = createHash('sha256')
for (const name of ['boot', 'chat', 'concourse']) digest.update(readFileSync(join(scenes, `${name}.json`)))
const identity = { baseSha: BASE, tipSha: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD:src'), sceneDigest: digest.digest('hex'), cols: 177, rows: 49, platform: process.platform, architecture: process.arch, box: cpus()[0]?.model ?? 'unreported', osRelease: release(), terminal: 'Apple_Terminal identity over byte-exact POSIX pty', repetitions: 5, comparison: liveBase ? 'live base and tip on this box' : 'tip against committed base record' }
const report = { ...identity, silentKeys, base, tip, noise: timingNoise(liveBase ? runs.base : recorded!.runs, runs.tip), runs }
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n')
if (recordingBase) writeFileSync(baselinePath, JSON.stringify({ ...identity, measuredAt: new Date().toISOString(), silentKeys, medians: base, runs: runs.base }, null, 2) + '\n', { flag: 'wx' })
let failures = 0
if (recorded) {
  assert.equal(recorded.baseSha, BASE, 'recorded base identity differs')
  assert.equal(recorded.sceneDigest, identity.sceneDigest, 'the measured scenes changed')
  assert.deepEqual(fiveRunMedians(recorded.runs), recorded.medians, 'the committed medians do not follow their five recorded runs')
  if (liveBase) {
    for (const key of Object.keys(base)) {
      const spreadOf = (samples: Array<{ metrics: Metrics }>): number => {
        const values = samples.map(run => run.metrics[key]!)
        return Math.max(...values) - Math.min(...values)
      }
      const spread = Math.max(spreadOf(runs.base), spreadOf(recorded.runs))
      const exact = !key.endsWith('Ms')
      const agrees = exact ? base[key] === recorded.medians[key] : Math.abs(base[key]! - recorded.medians[key]!) <= spread
      if (!agrees) failures++
      console.log(`[${agrees ? 'PASS' : 'FAIL'}] base record ${key}: recorded ${recorded.medians[key]} live ${base[key]}${exact ? ' (exact)' : ` (observed five-run spread ${spread})`}`)
    }
  } else console.log('[BASE RECORD] base git object absent; tip compared with the committed five-run record, not a same-box live comparison')
}
const noise = timingNoise(liveBase ? runs.base : recorded!.runs, runs.tip)
for (const row of costRows(base, tip, noise)) {
  if (!row.pass) failures++
  const floor = row.floor > 0 ? ` (five-run noise ${row.floor.toFixed(6)}: ${row.tip - row.base > 0 ? '+' : ''}${(row.tip - row.base).toFixed(6)})` : ' (exact)'
  console.log(`[${row.pass ? 'PASS' : 'FAIL'}] ${row.metric}: base ${row.base.toFixed(6)} tip ${row.tip.toFixed(6)}${floor}`)
}
const fullBudget = argument('--full-budget-ms')
if (fullBudget !== undefined && tip.fullFrameMs! > Number(fullBudget)) {
  failures++
  console.log(`[FAIL] full-frame renderer ${tip.fullFrameMs}ms exceeds ${fullBudget}ms`)
}
console.log(`[${failures ? 'FAIL' : 'PASS'}] frame cost: ${failures} regressions; five runs per build; receipts ${work}`)
process.exit(failures ? 1 : 0)
