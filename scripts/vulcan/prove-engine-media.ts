import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENGINE_OPS, engineOpPermissionMessage, runEngineOp } from '../../src/services/vulcan/engine/ops.js'
import { parseEngineMediaRequest, engineMediaStats } from '../../src/services/vulcan/engine/media.js'
import { EngineJobService } from '../../src/services/vulcan/engine/service.js'
import { parseEngineTreeSpec } from '../../src/services/vulcan/engine/frozenTree.js'
import { liveEngines } from '../../src/services/vulcan/engine/spawn.js'
import { engineRunPath, engineTreePath } from '../../src/services/vulcan/engine/paths.js'
import { decodePng, encodePng } from '../../src/tools/FileReadTool/imageProcessorJs.js'
import { resolveGodotExecutable } from '../../src/services/vulcan/portabilityDoctor.js'
import { godotEngineCli, parseGodotCliArgs } from '../../src/cli/godotEngineCli.js'
import { vulcanOp } from '../../src/utils/vulcan/optable.generated.js'

assert.ok(
  ['engine_capture', 'engine_frames', 'engine_profile'].every(op => ENGINE_OPS.has(op)),
  'engine_capture, engine_frames and engine_profile must be registered',
)

const root = resolve(import.meta.dir, '../..')
const artifactArg = process.argv.indexOf('--artifacts')
const scratch = artifactArg >= 0 ? resolve(process.argv[artifactArg + 1]!) : mkdtempSync(join(tmpdir(), 'engine-media-proof-'))
mkdirSync(scratch, { recursive: true })
const config = join(scratch, 'config')
mkdirSync(config, { recursive: true })
process.env.MERCURY_CONFIG_DIR = config
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_GODOT_WORKERS = '2'
process.env.ANTHROPIC_API_KEY = 'fixture-key-not-live'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.OPENAI_API_KEY = 'fixture-key-not-live'
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1'
const project = join(scratch, 'game')
cpSync(join(import.meta.dir, 'fixtures/engine-service'), project, { recursive: true })
mkdirSync(join(project, '.mercury'), { recursive: true })
cpSync(join(project, 'engine-suites.json'), join(project, '.mercury/engine-suites.json'))
const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'main')
git('add', 'project.godot', 'engine-suites.json', '.gitignore', 'autoload', 'src', 'tests', 'shaders')
writeFileSync(join(scratch, 'fixture-message.txt'), 'Add an isolated engine fixture\n')
git('commit', '-q', '-F', join(scratch, 'fixture-message.txt'))
const commit = git('rev-parse', 'HEAD')
let checks = 0
const evidence: Array<{ label: string; value: unknown }> = []
function check(label: string, condition: unknown, value?: unknown): void {
  assert.ok(condition, `${label}${value === undefined ? '' : ': ' + JSON.stringify(value)}`)
  checks++
  console.log(`PASS ${label}`)
  if (value !== undefined) evidence.push({ label, value })
}
async function op(name: string, args: Record<string, unknown>): Promise<any> {
  const text = await runEngineOp(name, args, project)
  try { return JSON.parse(text) } catch { throw new Error(`${name}: ${text}`) }
}
function planted(name: string, width: number, height: number, pixel: (x: number, y: number) => number[]): string {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4)
  const file = join(project, name + '.png')
  writeFileSync(file, encodePng({ width, height, data }))
  return file
}
for (const [name, cls] of [['engine_capture', 'exec'], ['engine_profile', 'exec'], ['engine_frames', 'mutate']]) {
  const spec = vulcanOp(name!)
  check(`${name} runs on Mercury's side with its permission class`, spec?.side === 'mercury' && spec.cls === cls)
}

const flat = planted('flat', 32, 24, () => [32, 96, 160, 255])
const patch = planted('patch', 32, 24, (x, y) => x >= 4 && x < 12 && y >= 6 && y < 10 ? [255, 0, 0, 255] : [32, 96, 160, 255])
const tiles = planted('tiles', 32, 24, (x, y) => ((Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0) ? [255, 255, 255, 255] : [0, 0, 0, 255])
const streaks = planted('streaks', 32, 24, x => x % 4 < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])
const flatBytes = readFileSync(flat)
const diff = await op('engine_frames', { action: 'diff', a: flat, b: patch })
check('diff counts only the planted rectangle', diff.changedPixels === 32 && diff.changedFraction === 32 / (32 * 24), diff)
check('diff bounding box uses source coordinates', JSON.stringify(diff.components) === JSON.stringify([{ x: 4, y: 6, width: 8, height: 4, pixels: 32 }]))
const same = await op('engine_frames', { action: 'diff', a: flat, b: flat })
check('identical frames have no changed component', same.changedPixels === 0 && same.changedFraction === 0 && same.components.length === 0)
check('two frame operations never share an output path', diff.mask.path !== same.mask.path && existsSync(diff.mask.path) && existsSync(same.mask.path))
const flatStats = await op('engine_frames', { action: 'stats', frame: flat, grid: [4, 3], maxLag: 8 })
check('flat colour has zero anisotropy and high-frequency energy', flatStats.anisotropy.strength === 0 && flatStats.highFrequencyEnergy === 0 && flatStats.anisotropy.orientationDegrees === null, flatStats)
check('flat correlations are explicitly undefined', [...flatStats.autocorrelation.rows, ...flatStats.autocorrelation.columns].every((x: any) => x.correlation === null))
check('every grid region returns the planted RGBA mean', flatStats.grid.regions.length === 12 && flatStats.grid.regions.every((x: any) => JSON.stringify(x.meanRgba) === '[32,96,160,255]'))
const tileStats = await op('engine_frames', { action: 'stats', frame: tiles, maxLag: 8 })
check('tile period four repeats in both axes', [tileStats.autocorrelation.rows, tileStats.autocorrelation.columns].every((axis: any[]) => Math.abs(axis.find(x => x.lag === 4).correlation - 1) < 1e-10), tileStats)
check('tile half-period reverses both axes', [tileStats.autocorrelation.rows, tileStats.autocorrelation.columns].every((axis: any[]) => Math.abs(axis.find(x => x.lag === 2).correlation + 1) < 1e-10))
check('repeated tiles carry nonzero high-frequency energy', tileStats.highFrequencyEnergy > 0)
const streakStats = await op('engine_frames', { action: 'stats', frame: streaks, maxLag: 8 })
check('vertical streaks return full anisotropy and vertical direction', Math.abs(streakStats.anisotropy.strength - 1) < 1e-10 && streakStats.anisotropy.orientationDegrees === 90, streakStats)
const contact = await op('engine_frames', { action: 'contact-sheet', frames: [flat, patch, tiles, streaks] })
check('contact sheet places four frames in row-major order', contact.frames.length === 4 && contact.frames[0].x === 0 && contact.frames[1].x > 0 && contact.frames[2].y > 0 && existsSync(contact.path), contact)
const preview = decodePng(readFileSync(flatStats.preview.path))
check('preview is a small real PNG', preview.width <= 320 && preview.height <= 320)
const invalid = await op('engine_frames', { action: 'diff', a: flat, b: patch, output: flat })
check('frame ops refuse caller-selected overwrite paths', /Unsupported/.test(invalid.error))
check('source pixels remain untouched', readFileSync(flat).equals(flatBytes))
const malformed = join(project, 'malformed.png')
writeFileSync(malformed, Buffer.from([137, 80, 78, 71]))
check('malformed PNGs are refused as data', typeof (await op('engine_frames', { action: 'stats', frame: malformed })).error === 'string')
for (const p of ['../outside', '/absolute', 'a/b']) {
  assert.throws(() => engineRunPath(project, p), /not a path/)
  assert.throws(() => engineTreePath(project, p), /not a path/)
}
check('run identifiers cannot escape their estate', true)
const cliParsed = parseGodotCliArgs(['frames', 'stats', flat, '--grid', '4x3', '--max-lag', '8'])
check('CLI frame options retain their values', cliParsed.flags.grid === '4x3' && cliParsed.flags['max-lag'] === '8')
let cliText = ''
const cliIo = { out: (line: string) => { cliText = line }, err: (line: string) => { cliText = line }, cliName: 'mercury' }
check('CLI frames executes the statistics op', await godotEngineCli(['frames', 'stats', flat, '--grid', '4x3', '--project', project], cliIo) === 0 && JSON.parse(cliText).grid.regions.length === 12)

check('display routes name the window in the permission request', engineOpPermissionMessage('engine_capture', { route: 'display' })?.includes('asks for the real display') && engineOpPermissionMessage('engine_profile', { display: true })?.includes('asks for the real display'))
check('median and nearest-rank p95 name the actual order statistics', JSON.stringify(engineMediaStats([4, 1, 3, 2], 'fixture')) === JSON.stringify({ samples: 4, median: 2.5, p95: 4 }))
check('CLI missing numeric values refuse rather than silently default', await godotEngineCli(['frames', 'stats', flat, '--max-lag', '--project', project], cliIo) === 2)
const executable = await resolveGodotExecutable({ census: [] })
if (!executable.resolved) {
  console.log('SKIP real-engine captures and profiles: no Godot executable is available')
  evidence.push({ label: 'live engine', value: 'SKIP: no Godot executable' })
} else {
  const service = EngineJobService.for(project, { workers: 2, executable: executable.resolved })
  const clock = { simulationTime: 2, shaderTime: 3, seed: 1234, fps: 60 }
  const captureArgs = { tour: 'fixture', clock, settleFrames: 3, budgetMs: 120_000 }
  try {
    const first = await op('engine_capture', captureArgs)
    check('first real headless tour finishes on a frozen commit', first.allPass === true && first.complete === true && first.tree.commit === commit, first)
    const second = await op('engine_capture', captureArgs)
    check('second real headless tour finishes', second.allPass === true, second)
    check('repeated tour frames are byte identical', first.frames.length === 2 && second.frames.length === 2 && first.frames.every((frame: any, i: number) => readFileSync(frame.path).equals(readFileSync(second.frames[i].path))))
    check('two capture runs never share a frame path', first.frames.every((frame: any) => !second.frames.some((other: any) => frame.path === other.path)))
    check('every frame names its frozen tour step', first.frames[0].step.name === 'front' && first.frames[1].step.name === 'side' && first.frames[1].stepIndex === 1)
    check('headless evidence names project pixels and cooperative clocks', first.media.route === 'headless' && first.media.displayRequested === false && first.media.evidence[0].pixelSource.includes('project-provided') && first.media.evidence[0].shaderClock === true)
    const resultRecord = await op('engine_result', { id: first.jobId })
    check('engine_result retains every frame and the contact sheet', resultRecord.frames.length === 2 && existsSync(resultRecord.media.contactSheet.path))
    const snapshotSpec = parseEngineTreeSpec('HEAD')
    assert.ok(!('error' in snapshotSpec))
    const mutable = { suites: [], tree: snapshotSpec, native: false, capture: true, priority: 'lane-gate' as const, budgetMs: 120_000, displayShared: false, keepTree: false, label: null, media: parseEngineMediaRequest('capture', captureArgs, project) }
    const pendingSnapshot = service.submit(mutable)
    mutable.media.clock.seed = 999
    mutable.tree.ref = 'missing-ref'
    const snapshotJob = await pendingSnapshot
    assert.ok(!('refused' in snapshotJob))
    const snapshot = await service.wait(snapshotJob.id, 120_000)
    check('submission snapshots clock and tree before yielding', snapshot?.record?.allPass === true && snapshot.record.media?.request.clock.seed === 1234 && snapshot.record.tree.ref === 'HEAD' && readFileSync(snapshot.record.frames![0]!.path).equals(readFileSync(first.frames[0].path)))
    const pair = await op('engine_capture', { ...captureArgs, pair: { switch: 'feature', a: false, b: true } })
    check('a capture pair is two boots of the same tour', pair.allPass === true && pair.media.boots === 2 && pair.media.tourHash === first.media.tourHash && pair.frames.length === 4, pair)
    for (let i = 0; i < 2; i++) {
      const pairDiff = await op('engine_frames', { action: 'diff', a: pair.frames[i].path, b: pair.frames[i + 2].path })
      check(`pair step ${i} changes only the switched rectangle`, pairDiff.changedPixels === 192 && pairDiff.changedFraction === 192 / (64 * 48) && JSON.stringify(pairDiff.components) === JSON.stringify([{ x: 8, y: 10, width: 16, height: 12, pixels: 192 }]), pairDiff)
      check(`pair control step ${i} equals the standalone tour`, readFileSync(pair.frames[i].path).equals(readFileSync(first.frames[i].path)))
    }
    const sheet = await op('engine_frames', { action: 'contact-sheet', id: pair.jobId })
    check('contact sheet reads the run record without touching source frames', sheet.frames.length === 4 && existsSync(sheet.path), sheet)
    const hidden = await op('engine_capture', { ...captureArgs, route: 'hidden' })
    check('unavailable hidden startup refuses without a visible fallback', /hidden run refused/.test(hidden.error), hidden)
    const sceneCapture = await op('engine_capture', { ...captureArgs, tour: { scene: 'res://tests/media_scene.tscn', steps: [{ name: 'scene' }] } })
    check('a PackedScene tour uses the same isolated capture driver', sceneCapture.allPass === true && sceneCapture.frames.length === 1, sceneCapture)
    const profileArgs = { tour: 'fixture', source: 'project', settleFrames: 30, sampleFrames: 60, budgetMs: 120_000, pair: { switch: 'feature', a: false, b: true } }
    const spec = parseEngineTreeSpec('HEAD')
    assert.ok(!('error' in spec))
    const busy = await service.submit({ suites: ['long_checks'], tree: spec, native: false, capture: false, priority: 'lane-gate', budgetMs: 120_000, displayShared: false, keepTree: false, label: 'guard-worker' })
    assert.ok(!('refused' in busy))
    for (let i = 0; i < 250 && !liveEngines().some(engine => engine.label.startsWith(`${busy.id}:`)); i++) await new Promise(resolve => setTimeout(resolve, 20))
    check('the competing real engine worker is alive', liveEngines().some(engine => engine.label.startsWith(`${busy.id}:`)))
    const refused = await op('engine_profile', profileArgs)
    check('profiler refuses with the quiet guard words while a worker lives', /quiet-machine guard refused profile/.test(refused.error), refused)
    if (process.argv.includes('--built')) {
      const crossRequest = join(scratch, 'cross-process-profile.json')
      writeFileSync(crossRequest, JSON.stringify(profileArgs))
      let crossOutput = ''
      let crossCode = 0
      try {
        crossOutput = execFileSync('node', [join(root, 'dist/mercury.mjs'), 'godot', 'profile', '--request', crossRequest, '--project', project], { cwd: project, env: { ...process.env, MERCURY_GODOT_EXECUTABLE: executable.resolved }, encoding: 'utf8', timeout: 60_000 })
      } catch (e) {
        crossCode = Number((e as { status?: number }).status)
        crossOutput = String((e as { stdout?: string }).stdout ?? '')
      }
      check('a fresh CLI refuses profiling instead of sweeping another owner', crossCode !== 0 && /quiet-machine guard refused profile/.test(crossOutput) && liveEngines().some(engine => engine.label.startsWith(`${busy.id}:`)), { code: crossCode, output: crossOutput })
      check('the other owner retains its frozen tree', existsSync(busy.treePath))
    }
    await service.cancel(busy.id)
    check('the competing worker is reaped before profiling', !liveEngines().some(engine => engine.label.startsWith(`${busy.id}:`)))
    const profile = await op('engine_profile', { ...profileArgs, baseline: { save: true } })
    check('alone, the real profiler returns settled phases', profile.allPass === true && profile.media.phases.length === 4 && profile.media.quiet.contaminated === false, profile)
    check('both A/B halves stay inside one boot', profile.media.boots === 1 && profile.media.phases.map((phase: any) => phase.variant).join(',') === 'a,a,b,b')
    const profileBoot = profile.results.find((row: any) => row.name === 'profile')
    const bootObservations = profile.media.quiet.observations.filter((o: any) => o.stage === 'measurement-boot').length
    check('the quiet guard samples the measurement boot about once a second and keeps the before and after observations', bootObservations <= Math.ceil(profileBoot.seconds) + 1 && ['before-import', 'before-measurement-boot', 'after-measurement-boot'].every(stage => profile.media.quiet.observations.some((o: any) => o.stage === stage)), { bootObservations, seconds: profileBoot.seconds })
    const profileLog = readFileSync(profile.results.find((row: any) => row.name === 'profile').log, 'utf8')
    const toggleLines = profileLog.split('\n').filter(line => line.startsWith('FIXTURE TOGGLE ')).map(line => JSON.parse(line.slice('FIXTURE TOGGLE '.length)))
    check('the toggle hook flips twice in the same engine process', toggleLines.length === 2 && toggleLines[0].pid === toggleLines[1].pid && JSON.stringify(toggleLines[1].values) === '[false,true]')
    check('frame median and p95 are measured positive milliseconds', profile.media.phases.every((phase: any) => phase.frameMs.samples === 60 && phase.frameMs.median > 0 && phase.frameMs.p95 >= phase.frameMs.median))
    check('headless GPU timings are unavailable rather than zero claims', profile.media.phases.every((phase: any) => phase.gpuMs === null))
    check('script and physics instrumentation retain named samples', profile.media.phases.every((phase: any) => phase.scripts[0].script === 'res://tests/media_fixture.gd' && phase.scripts[0].selfMs.samples === 60 && phase.physics.fixtureTick.samples === 60))
    check('a quiet committed run stores its immutable baseline', typeof profile.media.baseline.saved === 'string' && existsSync(profile.media.baseline.saved) && profile.media.baseline.saved.endsWith(`${commit}.json`))
    const baselineBytes = readFileSync(profile.media.baseline.saved)
    const comparison = await op('engine_profile', { ...profileArgs, baseline: { compare: commit, save: true } })
    check('baseline comparison names both numbers and their delta', comparison.allPass === true && comparison.media.baseline.comparable === true && comparison.media.baseline.metrics.some((metric: any) => metric.metric === 'a/0/frameMs/median' && Number.isFinite(metric.baseline) && Number.isFinite(metric.current) && metric.delta === metric.current - metric.baseline), comparison.media.baseline)
    check('saving another baseline never overwrites the original', readFileSync(profile.media.baseline.saved).equals(baselineBytes) && comparison.media.baseline.saved === null)
    const requestPath = join(scratch, 'capture-request.json')
    writeFileSync(requestPath, JSON.stringify(captureArgs))
    check('CLI tour returns a frozen named run with a contact sheet', await godotEngineCli(['tour', 'fixture', '--request', requestPath, '--project', project], cliIo) === 0 && existsSync(JSON.parse(cliText).media.contactSheet.path))
    const bundle = join(root, 'dist/mercury.mjs')
    if (process.argv.includes('--built')) {
      const cliRequest = join(scratch, 'profile-request.json')
      writeFileSync(cliRequest, JSON.stringify(profileArgs))
      for (const args of [
        ['capture', 'fixture', '--request', requestPath],
        ['frames', 'stats', flat, '--grid', '4x3'],
        ['profile', 'fixture', '--request', cliRequest],
        ['tour', 'fixture', '--request', requestPath],
      ]) {
        const output = execFileSync('node', [bundle, 'godot', ...args, '--project', project], { cwd: project, env: { ...process.env, MERCURY_GODOT_EXECUTABLE: executable.resolved }, encoding: 'utf8', timeout: 180_000 })
        const result = JSON.parse(output)
        check(`built CLI ${args[0]} executes and returns JSON`, args[0] === 'frames' ? result.grid.regions.length === 12 : result.allPass === true, { command: ['node', 'dist/mercury.mjs', 'godot', ...args], result })
      }
    }
  } finally {
    await service.shutdown()
    check('all workers owned by the media proof are gone', liveEngines().length === 0)
  }
}
writeFileSync(join(scratch, 'evidence.json'), JSON.stringify({ checks, commit, evidence }, null, 2))
console.log(`PASS ${checks} engine media checks; evidence ${join(scratch, 'evidence.json')}`)
