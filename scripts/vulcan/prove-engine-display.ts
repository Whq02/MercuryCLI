import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { EngineJob, EngineJobRequest, EngineResultRow, EngineRunRecord } from '../../src/services/vulcan/engine/service.js'
import type { EngineHandle } from '../../src/services/vulcan/engine/spawn.js'

const args = process.argv.slice(2)
const suppliedGodot = process.env.GODOT_BIN
let godot: string | null = null
try {
  if (suppliedGodot && isAbsolute(suppliedGodot) && statSync(suppliedGodot).isFile()) {
    accessSync(suppliedGodot, constants.X_OK)
    godot = resolve(suppliedGodot)
  }
} catch {
  godot = null
}

if (!godot) {
  console.log('SKIP native display proof: supply GODOT_BIN as an absolute executable Godot path; no engine was started')
} else if (!args.includes('--display')) {
  console.log('SKIP native display proof: --display is required to authorize visible Godot windows; no engine was started')
} else {
  await main(godot)
}

async function main(executable: string): Promise<void> {
  const allowed = new Set(['--display', '--profile', '--built', '--artifacts'])
  let artifacts: string | null = null
  for (let i = 0; i < args.length; i++) {
    assert.ok(allowed.has(args[i]!), `Unknown native proof option: ${args[i]}`)
    if (args[i] === '--artifacts') {
      assert.ok(args[i + 1] && !args[i + 1]!.startsWith('--'), '--artifacts needs a directory')
      assert.equal(artifacts, null, '--artifacts may be supplied only once')
      artifacts = resolve(args[++i]!)
    }
  }
  assert.ok(artifacts, 'An opted-in native proof requires --artifacts <directory>')
  const repository = resolve(import.meta.dir, '../..')
  const under = (parent: string, file: string): boolean => {
    const rel = relative(parent, file)
    return rel.length > 0 && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
  }
  assert.ok(artifacts !== repository && !under(repository, artifacts), 'Keep native proof artifacts outside the source checkout')
  const bundle = join(repository, 'dist', 'mercury.mjs')
  if (args.includes('--built')) assert.ok(existsSync(bundle), '--built requires an already built dist/mercury.mjs; this proof never builds')
  mkdirSync(artifacts, { recursive: true })
  const scratch = mkdtempSync(join(artifacts, 'engine-display-'))
  const project = join(scratch, 'game')
  const config = join(scratch, 'config')
  const home = join(scratch, 'home')
  for (const dir of [project, config, home, join(project, 'tests'), join(project, '.mercury')]) mkdirSync(dir, { recursive: true })
  Object.assign(process.env, {
    HOME: home,
    APPDATA: home,
    XDG_DATA_HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    MERCURY_CONFIG_DIR: config,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_GODOT_WORKERS: '2',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: 'fixture-key-not-live',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    OPENAI_API_KEY: 'fixture-key-not-live',
    OPENAI_BASE_URL: 'http://127.0.0.1:1',
  })
  console.log(`ARTIFACTS ${scratch}`)
  console.log('DISPLAY AUTHORIZED: isolated native Godot windows will open; external editors and games are not controlled')

  const { EngineJobService } = await import('../../src/services/vulcan/engine/service.js')
  const { parseEngineMediaRequest } = await import('../../src/services/vulcan/engine/media.js')
  const { strictGodotCensus } = await import('../../src/services/vulcan/godotProcessCensus.js')
  const { parseEngineTreeSpec } = await import('../../src/services/vulcan/engine/frozenTree.js')
  const { runEngineOp } = await import('../../src/services/vulcan/engine/ops.js')
  const { liveEngines, spawnEngine, sweepEngineOrphans } = await import('../../src/services/vulcan/engine/spawn.js')
  const { decodePng } = await import('../../src/tools/FileReadTool/imageProcessorJs.js')
  const fixtureSource = join(import.meta.dir, 'fixtures', 'engine-service', 'tests', 'display_fixture.gd')
  copyFileSync(fixtureSource, join(project, 'tests', 'display_fixture.gd'))
  assert.ok(!/func\s+mercury_media_capture\s*\(/.test(readFileSync(fixtureSource, 'utf8')), 'Native fixture must not supply an Image capture hook')
  writeFileSync(join(project, 'project.godot'), [
    'config_version=5',
    '',
    '[application]',
    'config/name="mercury-native-viewport-fixture"',
    '',
    '[display]',
    'window/size/viewport_width=1280',
    'window/size/viewport_height=720',
    '',
  ].join('\n'))
  const manifest = {
    version: 1,
    executable,
    defaults: { timeoutMs: 120_000, importTimeoutMs: 180_000 },
    tours: { display: { script: 'res://tests/display_fixture.gd', steps: [{ name: 'canvas', frames: 2 }] } },
    suites: [],
  }
  writeFileSync(join(project, '.mercury', 'engine-suites.json'), JSON.stringify(manifest, null, 2))
  const git = (...gitArgs: string[]): string => execFileSync('git', ['-C', project, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...gitArgs], { encoding: 'utf8', env: process.env }).trim()
  git('init', '-q', '-b', 'main')
  git('add', 'project.godot', 'tests/display_fixture.gd', '.mercury/engine-suites.json')
  const messageFile = join(scratch, 'fixture-message.txt')
  writeFileSync(messageFile, 'Add an isolated native viewport fixture\n')
  git('commit', '-q', '-F', messageFile)
  const commit = git('rev-parse', 'HEAD')
  const service = EngineJobService.for(project, { workers: 2, executable })
  const ownedIds = new Set<string>()
  let cliHandle: EngineHandle | null = null
  let checks = 0
  let failure: string | null = null
  let cleanupFailure: string | null = null
  const evidence: Array<{ label: string; value: unknown }> = []
  const records: EngineRunRecord[] = []
  const reportFile = join(scratch, 'evidence.json')
  const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  const captureArgs = {
    tour: 'display',
    route: 'display',
    display: true,
    displayShared: true,
    clock: { simulationTime: 2, shaderTime: 3, seed: 1234, fps: 60 },
    pair: { switch: 'feature', a: false, b: true },
    settleFrames: 90,
    budgetMs: 240_000,
  }
  function check(label: string, condition: unknown, value: unknown = null): void {
    evidence.push({ label, value })
    assert.ok(condition, `${label}${value === null ? '' : ': ' + JSON.stringify(value)}`)
    checks++
    console.log(`PASS ${label}`)
  }
  async function op(name: string, input: Record<string, unknown>): Promise<any> {
    const output = await runEngineOp(name, input, project)
    let result: any
    try { result = JSON.parse(output) } catch { throw new Error(`${name} returned non-JSON: ${output}`) }
    return result
  }
  function request(label: string): EngineJobRequest {
    const tree = parseEngineTreeSpec(commit)
    assert.ok(!('error' in tree))
    return {
      suites: [], tree, native: true, capture: true, priority: 'lane-gate', budgetMs: captureArgs.budgetMs,
      displayShared: true, keepTree: false, label,
      media: parseEngineMediaRequest('capture', captureArgs, project),
    }
  }
  async function submit(label: string): Promise<EngineJob> {
    const job = await service.submit(request(label))
    assert.ok(!('refused' in job), 'refused' in job ? job.refused : '')
    ownedIds.add(job.id)
    return job
  }
  async function finish(job: EngineJob): Promise<EngineRunRecord> {
    const settled = await service.wait(job.id, 600_000)
    assert.ok(settled && settled.state !== 'queued' && settled.state !== 'running', `Native job ${job.id} did not settle`)
    assert.ok(settled.record, `Native job ${job.id} has no result`)
    records.push(settled.record)
    check(`${job.request.label} completes on its committed frozen tree`, settled.record.allPass && settled.record.complete && settled.record.tree.commit === commit, settled.record)
    return settled.record
  }
  function nativeEvidence(record: EngineRunRecord, label: string): void {
    const media = record.media
    assert.ok(media)
    check(`${label} records the explicitly requested display route`, media.route === 'display' && media.displayRequested === true && record.native === true)
    check(`${label} records actual non-dummy viewport rendering`, media.evidence.length > 0 && media.evidence.every(row => {
      const renderer = row.renderer as { driver?: string; method?: string } | undefined
      return row.pixelSource === 'Godot viewport' && row.displayDriver !== 'headless' && typeof row.displayDriver === 'string' && !!renderer?.driver && !!renderer.method && !/dummy|headless/i.test(renderer.driver + renderer.method)
    }), media.evidence)
    const rows = record.results.filter((row): row is EngineResultRow => !('skipped' in row) && row.name !== 'import')
    check(`${label} launches native rows without a hidden or headless argument`, rows.length > 0 && rows.every(row => row.ok && !row.argv.includes('--headless') && !row.argv.includes('--hidden')), rows.map(row => ({ name: row.name, argv: row.argv, startedAt: row.startedAt, endedAt: row.endedAt })))
  }
  function pixels(record: EngineRunRecord): void {
    assert.ok(record.media && record.frames)
    const frames = record.frames
    check(`${record.jobId} keeps four frames from two boots`, record.media.boots === 2 && frames.length === 4)
    const base = frames.filter(frame => frame.variant === 'a')
    const switched = frames.filter(frame => frame.variant === 'b')
    check(`${record.jobId} attributes every frame to its tour step and variant`, base.length === 2 && switched.length === 2 && frames.every(frame => frame.step.name === 'canvas' && frame.stepIndex === 0 && [0, 1].includes(frame.frameIndex)))
    check(`${record.jobId} keeps its real contact sheet`, !!record.media.contactSheet && existsSync(record.media.contactSheet.path) && record.media.contactSheet.frames.length === 4, record.media.contactSheet)
    for (const [variant, items] of [['a', base], ['b', switched]] as const) {
      const first = readFileSync(items[0]!.path)
      const second = readFileSync(items[1]!.path)
      check(`${record.jobId} stable ${variant} viewport frames are byte-identical`, first.equals(second), { first: items[0]!.path, second: items[1]!.path, firstSha256: hash(items[0]!.path), secondSha256: hash(items[1]!.path) })
    }
    const image = decodePng(readFileSync(base[0]!.path))
    check(`${record.jobId} captures a substantial native viewport`, image.width >= 640 && image.height >= 360, { width: image.width, height: image.height })
    const sample = (x: number, y: number): number[] => Array.from(image.data.slice((Math.floor(y * image.height) * image.width + Math.floor(x * image.width)) * 4, (Math.floor(y * image.height) * image.width + Math.floor(x * image.width)) * 4 + 4))
    const backdrop = sample(0.75, 0.5)
    const stripe = sample(0.0625, 0.5)
    const footer = sample(0.75, 0.9375)
    check(`${record.jobId} renders the distinctive blue field, teal stripe and gold footer`, backdrop[2]! > backdrop[1]! && backdrop[1]! > backdrop[0]! && stripe[1]! > stripe[0]! && stripe[2]! > stripe[0]! && footer[0]! > footer[1]! && footer[1]! > footer[2]!, { backdrop, stripe, footer })
  }

  try {
    const submissions = await Promise.allSettled([submit('native-first'), submit('native-second')])
    const jobs = submissions.map(result => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    const snapshot = service.jobs()
    const active = snapshot.running.filter(job => ownedIds.has(job.id))
    const queued = snapshot.queued.filter(job => ownedIds.has(job.id))
    check('the shared native slot queues the second concurrently submitted display job', active.length === 1 && queued.length === 1 && snapshot.display.nativeJob === active[0]!.id, snapshot)
    const completed = await Promise.all(jobs.map(finish))
    for (const record of completed) {
      nativeEvidence(record, record.jobId)
      pixels(record)
      const frames = record.frames!
      const job = jobs.find(item => item.id === record.jobId)!
      check(`${record.jobId} writes every frame beneath its own run`, frames.every(frame => under(job.runDir, resolve(frame.path)) && existsSync(frame.path)))
      const base = frames.filter(frame => frame.variant === 'a')
      const switched = frames.filter(frame => frame.variant === 'b')
      const image = decodePng(readFileSync(base[0]!.path))
      const x = Math.ceil(image.width * 0.25 - 0.5)
      const y = Math.ceil(image.height * 0.25 - 0.5)
      const width = Math.ceil(image.width * 0.5 - 0.5) - x
      const height = Math.ceil(image.height * 0.5 - 0.5) - y
      for (let i = 0; i < 2; i++) {
        const diff = await op('engine_frames', { action: 'diff', a: base[i]!.path, b: switched[i]!.path })
        check(`${record.jobId} pair frame ${i} changes only the shader's switched rectangle`, diff.changedPixels === width * height && diff.changedFraction === width * height / (image.width * image.height) && JSON.stringify(diff.components) === JSON.stringify([{ x, y, width, height, pixels: width * height }]), diff)
      }
      const reread = await op('engine_result', { id: record.jobId })
      check(`${record.jobId} result op retains its rendered frames and contact sheet`, reread.allPass === true && reread.frames.length === 4 && existsSync(reread.media.contactSheet.path))
    }
    const [first, second] = completed as [EngineRunRecord, EngineRunRecord]
    check('two actual display captures never share a frame path', new Set(completed.flatMap(record => record.frames!.map(frame => frame.path))).size === 8)
    check('two display jobs use the same frozen tour and clock', first.media!.tourHash === second.media!.tourHash && JSON.stringify(first.media!.request.clock) === JSON.stringify(second.media!.request.clock))
    for (let i = 0; i < 4; i++) check(`repeat native frame ${i} is byte-identical across independent boots`, readFileSync(first.frames![i]!.path).equals(readFileSync(second.frames![i]!.path)), { first: first.frames![i]!.path, second: second.frames![i]!.path, firstSha256: hash(first.frames![i]!.path), secondSha256: hash(second.frames![i]!.path) })
    const intervals = completed.flatMap(record => record.results.filter((row): row is EngineResultRow => !('skipped' in row) && row.name.startsWith('capture-')).map(row => ({ jobId: record.jobId, name: row.name, start: Date.parse(row.startedAt), end: Date.parse(row.endedAt) }))).sort((a, b) => a.start - b.start)
    check('native engine rows never overlap across the shared display slot', intervals.length === 4 && intervals.every((row, index) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end >= row.start && (index === 0 || intervals[index - 1]!.end <= row.start)), intervals)
    const firstIntervals = intervals.filter(row => row.jobId === active[0]!.id)
    const nextIntervals = intervals.filter(row => row.jobId === queued[0]!.id)
    check('the second display job waits for both boots of the first pair', Math.max(...firstIntervals.map(row => row.end)) <= Math.min(...nextIntervals.map(row => row.start)))

    const hidden = await op('engine_capture', { ...captureArgs, display: false, route: 'hidden' })
    check('the unsupported hidden route refuses instead of opening a fallback window', typeof hidden.error === 'string' && hidden.error.includes('hidden run refused'), hidden)
    if (args.includes('--profile')) {
      const profile = await op('engine_profile', { ...captureArgs, source: 'project', settleFrames: 90, sampleFrames: 120, quiet: 'flag', baseline: { save: false } })
      check('one native profile completes with both variants in one boot', profile.allPass === true && profile.media?.boots === 1 && profile.media.phases.length === 2, profile)
      records.push(profile)
      ownedIds.add(profile.jobId)
      nativeEvidence(profile, 'native profile')
      for (const phase of profile.media.phases) {
        check(`native profile ${phase.variant} measures settled frame timings`, phase.frameMs.samples === 120 && Number.isFinite(phase.frameMs.median) && phase.frameMs.median > 0 && phase.frameMs.p95 >= phase.frameMs.median, phase.frameMs)
        check(`native profile ${phase.variant} keeps project-instrumented script and physics tables`, phase.scripts.some((row: any) => row.script === 'res://tests/display_fixture.gd' && row.selfMs.samples === 120) && phase.physics.fixtureTick.samples === 120)
        check(`native profile ${phase.variant} reports real positive GPU samples or explicit unavailability`, phase.gpuMs === null || (phase.gpuMs.samples > 0 && phase.gpuMs.samples <= 120 && Number.isFinite(phase.gpuMs.median) && phase.gpuMs.median > 0 && phase.gpuMs.p95 >= phase.gpuMs.median), { status: phase.gpuMs === null ? 'unavailable' : 'reported', gpuMs: phase.gpuMs, renderCpuMs: phase.renderCpuMs, quiet: profile.media.quiet })
      }
      check('the observational native profile leaves baselines untouched', profile.media.baseline.saved === null)
    } else {
      evidence.push({ label: 'native GPU profile', value: 'SKIP: pass --profile to run one native A/B profile; GPU timing availability is not inferred from captures' })
    }

    if (args.includes('--built')) {
      const requestFile = join(scratch, 'built-capture-request.json')
      writeFileSync(requestFile, JSON.stringify({ ...captureArgs, pair: null, label: 'native-built' }, null, 2))
      const cliUser = join(scratch, 'cli-user')
      mkdirSync(cliUser, { recursive: true })
      cliHandle = spawnEngine({ executable: 'node', args: [bundle, 'godot', 'capture', '--request', requestFile, '--project', project, '--display', '--display-shared'], cwd: project, userDir: cliUser, timeoutMs: 300_000, label: 'native-display-built-cli' })
      const outcome = await cliHandle.done
      writeFileSync(join(scratch, 'built-capture.log'), outcome.output)
      check('the already built CLI completes one explicitly authorized native capture', outcome.exitCode === 0 && !outcome.signal && !outcome.timedOut && !outcome.spawnError, outcome)
      const captured = JSON.parse(outcome.output) as EngineRunRecord
      records.push(captured)
      check('the built CLI keeps its actual viewport frames', captured.allPass && captured.frames?.length === 2 && captured.frames.every(frame => existsSync(frame.path)), captured)
      nativeEvidence(captured, 'built native capture')
      cliHandle = null
    }
  } catch (e) {
    failure = e instanceof Error ? e.stack ?? e.message : String(e)
    throw e
  } finally {
    try {
      if (cliHandle) await cliHandle.kill('shutdown')
      await service.shutdown()
      const orphanReceipts = await sweepEngineOrphans(project, await strictGodotCensus())
      const remaining = service.jobs()
      const live = liveEngines().filter(engine => engine.label === 'native-display-built-cli' || [...ownedIds].some(id => engine.label.startsWith(`${id}:`)))
      const ownedProcesses = (await strictGodotCensus()).filter(engine => engine.project !== undefined && (resolve(engine.project) === project || under(project, resolve(engine.project))))
      check('finally removes queued/running proof jobs and reaps their engine workers', remaining.queued.length === 0 && remaining.running.length === 0 && live.length === 0 && ownedProcesses.length === 0, { queued: remaining.queued, running: remaining.running, live, ownedProcesses, orphanReceipts })
      EngineJobService.forget(project)
    } catch (e) {
      cleanupFailure = e instanceof Error ? e.stack ?? e.message : String(e)
      if (!failure) process.exitCode = 1
    }
    writeFileSync(reportFile, JSON.stringify({
      status: failure || cleanupFailure ? 'failed' : 'passed', checks, executable, commit, artifacts: scratch, project,
      displayOptIn: true, optionalProfile: args.includes('--profile'), optionalBuiltCli: args.includes('--built'),
      windowObservation: { status: 'not measured by this proof', note: 'This proof authorizes visible display jobs and verifies hidden-route refusal. The coordinating screen observer owns the independent OS-level minimized/hidden startup visibility and flash evidence; no negative sub-frame visibility assertion, screen capture or external editor control is performed here.' },
      failure, cleanupFailure, runs: records.map(record => ({ jobId: record.jobId, allPass: record.allPass, media: record.media, frames: record.frames })), evidence,
    }, null, 2))
    console.log(`EVIDENCE ${reportFile}`)
  }
  assert.equal(cleanupFailure, null, cleanupFailure ?? '')
  console.log(`PASS ${checks} native display checks; frames and evidence retained in ${scratch}`)
}
