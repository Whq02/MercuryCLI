import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

assert.ok(existsSync(resolve(import.meta.dir, '../../src/services/vulcan/engine/debuggerTransport.ts')), 'engine debugger transport must exist')

const root = resolve(import.meta.dir, '../..')
const artifactArg = process.argv.indexOf('--artifacts')
const scratch = artifactArg >= 0 ? resolve(process.argv[artifactArg + 1]!) : mkdtempSync(join(tmpdir(), 'engine-debugger-'))
mkdirSync(scratch, { recursive: true })
const config = join(scratch, 'config')
mkdirSync(config, { recursive: true })
Object.assign(process.env, { MERCURY_CONFIG_DIR: config, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: 'fixture-key-not-live', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', OPENAI_API_KEY: 'fixture-key-not-live', OPENAI_BASE_URL: 'http://127.0.0.1:1' })
const { decodeGodotVariant, encodeGodotVariant, encodeGodotPacket, GodotPacketDecoder, GodotDebuggerTransport } = await import('../../src/services/vulcan/engine/debuggerTransport.js')
const { GodotDebuggerProfile, decodeGodotProfileFrame } = await import('../../src/services/vulcan/engine/debuggerProfile.js')
const { parseEngineMediaRequest } = await import('../../src/services/vulcan/engine/media.js')
const { EngineJobService } = await import('../../src/services/vulcan/engine/service.js')
const { parseEngineTreeSpec } = await import('../../src/services/vulcan/engine/frozenTree.js')
const { liveEngines } = await import('../../src/services/vulcan/engine/spawn.js')
const { godotEngineCli, parseGodotCliArgs } = await import('../../src/cli/godotEngineCli.js')
const { vulcanOp } = await import('../../src/utils/vulcan/optable.generated.js')
const { resolveGodotExecutable } = await import('../../src/services/vulcan/portabilityDoctor.js')
let checks = 0
const evidence: Array<{ label: string; value: unknown }> = []
function check(label: string, condition: unknown, value?: unknown): void {
  assert.ok(condition, `${label}${value === undefined ? '' : ': ' + JSON.stringify(value)}`)
  checks++
  console.log(`PASS ${label}`)
  if (value !== undefined) evidence.push({ label, value })
}
function word(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value)
  return b
}
const scalar = [null, true, false, -7, 1.25, 'Godot λ', 'nul\0', 9007199254740993n, { nested: [2, false] }]
assert.deepEqual(decodeGodotVariant(encodeGodotVariant(scalar)), scalar)
check('Variant roundtrip preserves scalars, nesting, UTF-8 and exact int64', true)
const dict = Object.fromEntries([['__proto__', { planted: true }], ['constructor', 'data']])
assert.deepEqual(decodeGodotVariant(encodeGodotVariant(dict)), dict)
check('dictionary prototype keys stay data', ({} as any).planted === undefined)
assert.deepEqual(decodeGodotVariant(encodeGodotVariant(new Map([[7, 'seven']]))), new Map([[7, 'seven']]))
assert.deepEqual(decodeGodotVariant(Buffer.concat([word(28 | 0x10000), word(2), word(1), encodeGodotVariant(7)])), [7])
assert.deepEqual(decodeGodotVariant(Buffer.concat([word(27 | 0x50000), word(4), word(2), word(1), encodeGodotVariant('key'), encodeGodotVariant(7)])), { key: 7 })
check('typed arrays and dictionaries decode their type headers', true)
for (const [type, width, values] of [[29, 1, [1, 2, 255]], [30, 4, [-7, 8]], [31, 8, [9007199254740993n]], [32, 4, [1.5]], [33, 8, [1.25]], [35, 4, [[1, 2]]], [36, 4, [[1, 2, 3]]], [37, 4, [[1, 0, 0, 1]]], [38, 4, [[1, 2, 3, 4]]]] as const) {
  const components = (values as any[]).flat()
  const data = Buffer.alloc(Math.ceil(components.length * width / 4) * 4)
  components.forEach((v, i) => {
    if (type === 29) data.writeUInt8(v, i)
    else if (type === 30) data.writeInt32LE(v, i * width)
    else if (type === 31) data.writeBigInt64LE(v, i * width)
    else if (width === 8) data.writeDoubleLE(v, i * width)
    else data.writeFloatLE(v, i * width)
  })
  assert.deepEqual(decodeGodotVariant(Buffer.concat([word(type), word(values.length), data])), values)
}
assert.deepEqual(decodeGodotVariant(Buffer.concat([word(34), word(1), word(2), Buffer.from([65, 0, 0, 0])])), ['A'])
check('every packed array kind decodes with its element width', true)
const decoder = new GodotPacketDecoder()
const received: unknown[] = []
const packets = Buffer.concat([encodeGodotPacket(['a', 1, []]), encodeGodotPacket(['b', 1, [dict]])])
for (let i = 0; i < packets.length; i++) decoder.push(packets.subarray(i, i + 1), value => received.push(value))
decoder.finish()
assert.deepEqual(received, [['a', 1, []], ['b', 1, [dict]]])
const coalesced: unknown[] = []
new GodotPacketDecoder().push(packets, value => coalesced.push(value))
assert.deepEqual(coalesced, received)
check('fragmented and coalesced TCP packets retain message boundaries', true)
assert.throws(() => decodeGodotVariant(word(255)), /unknown Variant type 255/)
assert.throws(() => decodeGodotVariant(word(0), '4.7.0'), /version 4\.7\.0 is unsupported.*4\.6/)
assert.throws(() => decodeGodotVariant(Buffer.concat([word(4), word(9999)])), /truncated/)
assert.throws(() => decodeGodotVariant(Buffer.concat([word(0), word(0)])), /trailing bytes/)
assert.throws(() => new GodotPacketDecoder().push(word(9 << 20), () => {}), /invalid packet length/)
const truncated = new GodotPacketDecoder()
truncated.push(packets.subarray(0, 7), () => {})
assert.throws(() => truncated.finish(), /truncated packet/)
assert.throws(() => decodeGodotProfileFrame([1, 0, 0, 0, 0, 0, 0, 4]), /malformed/)
check('unknown types, wrong versions, truncation and oversize refuse with words', true)
const inlineTour = { script: 'res://tests/debugger_hot.gd', steps: [{ name: 'steady' }, { name: 'steady-again' }] }
const parsed = parseEngineMediaRequest('profile', { tour: inlineTour }, scratch)
check('default source is auto and the CLI retains explicit source', parsed.source === 'auto' && parseGodotCliArgs(['profile', '--source', 'engine']).flags.source === 'engine')
assert.throws(() => parseEngineMediaRequest('profile', { tour: inlineTour, source: 'invented' }, scratch), /source must be/)
const spec = vulcanOp('engine_profile')
check('profile source is registered on Mercury side', spec?.side === 'mercury' && typeof spec.args.source === 'string')
const wrongVersion = new GodotDebuggerProfile(parsed)
await wrongVersion.transport.listen()
const client = connect(wrongVersion.transport.port, '127.0.0.1')
try {
  await once(client, 'connect')
  const closed = once(client, 'close')
  client.write(encodeGodotPacket(['mercury_profile:hello', 1, [wrongVersion.transport.token, { major: 4, minor: 7, patch: 0 }]]))
  await closed
  check('a connected unsupported worker is refused rather than selected', /version 4\.7\.0 is unsupported/.test(wrongVersion.transport.error ?? '') && !wrongVersion.finished, wrongVersion.transport.error)
} finally { client.destroy(); await wrongVersion.transport.close() }
async function portIsFree(port: number): Promise<boolean> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    return true
  } catch { return false }
  finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) }
}
check('refused connections release their listener', await portIsFree(wrongVersion.transport.port))
const executable = process.env.GODOT_BIN ? { resolved: process.env.GODOT_BIN } : await resolveGodotExecutable({ census: [] })
if (!executable.resolved) {
  console.log('SKIP real engine debugger profiles: no Godot executable is available')
  evidence.push({ label: 'real engine', value: 'SKIP: no Godot executable' })
} else {
  const project = join(scratch, 'game')
  cpSync(join(import.meta.dir, 'fixtures/engine-service'), project, { recursive: true })
  mkdirSync(join(project, '.mercury'), { recursive: true })
  cpSync(join(project, 'engine-suites.json'), join(project, '.mercury/engine-suites.json'))
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', 'project.godot', 'engine-suites.json', '.gitignore', 'autoload', 'src', 'tests', 'shaders')
  writeFileSync(join(scratch, 'fixture-message.txt'), 'The fixture supplies a measured hot function\n')
  git('commit', '-q', '-F', join(scratch, 'fixture-message.txt'))
  const service = new EngineJobService(project, { workers: 2, executable: executable.resolved })
  const tree = parseEngineTreeSpec('HEAD')
  assert.ok(!('error' in tree))
  const args = { tour: inlineTour, source: 'engine', settleFrames: 30, sampleFrames: 180, quiet: 'flag', pair: { switch: 'feature', a: false, b: true } }
  const request = (values: Record<string, unknown>) => ({ suites: [], tree, native: false, capture: false, priority: 'profile' as const, budgetMs: 120_000, displayShared: false, keepTree: false, label: null, media: parseEngineMediaRequest('profile', values, project) })
  const run = async (values: Record<string, unknown>, owner = service) => {
    const job = await owner.submit(request(values))
    assert.ok(!('refused' in job), JSON.stringify(job))
    await owner.wait(job.id, 120_000)
    assert.ok(job.record?.allPass, JSON.stringify(job.record))
    return job.record!
  }
  const engineEvidence = (record: any) => record.media.evidence.find((e: any) => e.source === 'engine debugger')
  try {
    const record = await run(args)
    const engine = engineEvidence(record)
    check('the real headless engine source completes without project instrumentation', record.media?.selectedSource === 'engine' && engine.complete && record.media.evidence[0].projectTables === false && record.results.every((row: any) => row.instance === null), record)
    check('actual engine and decoder versions are carried', engine.decoderVersion === '4.6' && engine.engine.major === 4 && engine.engine.minor === 6)
    check('one boot keeps both variants and all tour steps', record.media?.boots === 1 && record.media.phases.map(p => `${p.variant}/${p.stepIndex}`).join(',') === 'a/0,a/1,b/0,b/1')
    for (const phase of engine.phases) {
      const hot = phase.scripts.find((s: any) => /debugger_hot\.gd::\d+::hot_function$/.test(s.script))
      const calls = phase.variant === 'a' ? 7 : 11
      check(`${phase.variant}/${phase.stepIndex} hot function matches every loop call`, hot?.calls.samples === 180 && hot.calls.median === calls && hot.calls.p95 === calls && hot.totalCalls === calls * 180 && hot.selfMs.median > 0, hot)
      check(`${phase.variant}/${phase.stepIndex} server table carries physics`, Object.keys(phase.servers).some(key => key.startsWith('physics_2d/')) && Object.keys(phase.physics).some(key => key.startsWith('physics_2d/')))
      check(`${phase.variant}/${phase.stepIndex} monitors carry frame time and real memory`, phase.monitors.frameMs.samples === 180 && phase.monitors.frameMs.median > 0 && phase.monitors.performanceSamples >= 1 && phase.monitors.memoryBytes.median > 0)
    }
    check('completed profile listener is closed', await portIsFree(engine.port))
    const projectRecord = await run({ tour: 'fixture', source: 'project', settleFrames: 10, sampleFrames: 12, quiet: 'flag' })
    check('explicit project source retains original table shape', projectRecord.media?.selectedSource === 'project' && projectRecord.media.phases.every(p => p.scripts[0]?.script === 'res://tests/media_fixture.gd' && p.physics.fixtureTick.samples === 12) && !engineEvidence(projectRecord), projectRecord)
    const both = await run({ tour: 'fixture', settleFrames: 10, sampleFrames: 12, quiet: 'flag' })
    const tables = both.media!.evidence.find(e => e.source === 'project') as any
    check('auto chooses engine and preserves separately labelled project tables', both.media?.selectedSource === 'engine' && both.media.sources?.join(',') === 'project,engine debugger' && tables.phases.every((p: any) => p.scripts[0].script === 'res://tests/media_fixture.gd' && p.physics.fixtureTick.samples === 12), both)
    const starts = await Promise.all([service.submit(request({ ...args, pair: null, sampleFrames: 180 })), service.submit(request({ ...args, pair: null, sampleFrames: 180 }))])
    assert.ok(starts.every(job => !('refused' in job)))
    const jobs = starts as Array<Exclude<(typeof starts)[number], { refused: string }>>
    await Promise.all(jobs.map(job => service.wait(job.id, 120_000)))
    const pair = jobs.map(job => job.record!)
    check('simultaneous profile jobs both finish with distinct ports', pair.every(r => r.allPass) && engineEvidence(pair[0]).port !== engineEvidence(pair[1]).port, pair)
    const rows = pair.map(r => r.results.find(row => row.name === 'profile') as any)
    check('the two measurement boots overlap', rows[0].startedAt < rows[1].endedAt && rows[1].startedAt < rows[0].endedAt)
    check('both concurrent listeners close', (await Promise.all(pair.map(r => portIsFree(engineEvidence(r).port)))).every(Boolean))
    const wrapper = join(scratch, 'without-debugger.cjs')
    writeFileSync(wrapper, `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nconst at=args.indexOf('--remote-debug');\nif(at>=0) args.splice(at,2);\nconst result=spawnSync(${JSON.stringify(executable.resolved)},args,{stdio:'inherit',env:process.env});\nprocess.exit(result.status ?? 1);\n`)
    chmodSync(wrapper, 0o755)
    const disconnected = new EngineJobService(project, { workers: 1, executable: wrapper })
    try {
      const fallback = await run({ tour: 'fixture', settleFrames: 10, sampleFrames: 12, quiet: 'flag' }, disconnected)
      check('a game that never connects falls back to project with the reason', fallback.media?.selectedSource === 'project' && /never connected/.test(fallback.media.fallbackReason ?? '') && engineEvidence(fallback).connected === false, fallback)
      check('the unused listener also closes', await portIsFree(engineEvidence(fallback).port))
    } finally { await disconnected.shutdown() }
    let cliText = ''
    const io = { out: (line: string) => { cliText = line }, err: (line: string) => { cliText = line }, cliName: 'mercury' }
    check('CLI refuses an unknown source without spawning', await godotEngineCli(['profile', '--source', 'invented', '--project', project], io) === 2 && /source needs/.test(cliText))
    check('CLI refuses a missing source value without spawning', await godotEngineCli(['profile', '--source', '--project', project], io) === 2)
    if (process.argv.includes('--built')) {
      const requestFile = join(scratch, 'cli-profile.json')
      writeFileSync(requestFile, JSON.stringify({ tour: 'fixture', settleFrames: 10, sampleFrames: 12, quiet: 'flag' }))
      for (const source of ['engine', 'project']) {
        const output = execFileSync('node', [join(root, 'dist/mercury.mjs'), 'godot', 'profile', '--request', requestFile, '--source', source, '--project', project], { encoding: 'utf8', timeout: 120_000, cwd: project, env: { ...process.env, MERCURY_GODOT_EXECUTABLE: executable.resolved } })
        const record = JSON.parse(output)
        check(`built CLI selects ${source} and finishes`, record.allPass && record.media.selectedSource === source, record)
      }
    }
  } finally {
    await service.shutdown()
    check('every proof-owned worker is gone', liveEngines().length === 0)
  }
}
writeFileSync(join(scratch, 'evidence.json'), JSON.stringify({ checks, evidence }, null, 2))
console.log(`PASS ${checks} engine debugger checks; evidence ${join(scratch, 'evidence.json')}`)
