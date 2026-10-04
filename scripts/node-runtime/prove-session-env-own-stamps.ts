#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { plugin } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { startScriptedFixture, seedScratchHome, type SeenResult } from '../lib/scriptedTurn.ts'
import { LineReader, inputLine, lastOutcome, promptRow, type Frame } from '../lib/rows.ts'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const tally = makeTally('prove-session-env-own-stamps')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'session-env-own-stamps-')))
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

for (const name of Object.keys(process.env)) {
  if ((name.startsWith('MERCURY_') && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE', 'MERCURY_DESKTOP_DRIVER'].includes(name)) || name === 'NODE_COMPILE_CACHE' || name === 'NODE_PATH' || name === 'MHOME') delete process.env[name]
}

const stamps = await import('../../src/substrate/envStamps.ts')
const { sessionEnvStamps, scrubSessionEnvStamps, stampSpawnReceipt, spawnSelfStamped, recordOwnEnvWrite, resetOwnEnvWritesForTesting, LAUNCHER_STAMPS, COMPILE_CACHE_ENV } = stamps

tally.section('§1 the config home a daemon stamped, the cache lever and the launchers\' scratch are the session\'s own')
const home = join(scratch, 'home')
const pack = join(scratch, 'pack', 'node_modules')
const { getMercuryHome } = await import('../../src/utils/envUtils.ts')
const proofHome = process.env.MERCURY_CONFIG_DIR
const pinHome = (dir: string | undefined): void => {
  if (dir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = dir
  getMercuryHome.cache.clear()
}
pinHome(home)
const field: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  MERCURY_CONFIG_DIR: home,
  NODE_COMPILE_CACHE: join(home, 'compile-cache'),
  MHOME: home,
  MERCURY_WIN32_UTF8_PRESET: '1',
  MERCURY_LAUNCH_ID: 'cmd-1234-5678',
  MERCURY_MODEL_LANES: '1',
}
stampSpawnReceipt(field, ['MERCURY_CONFIG_DIR'])
tally.check('the daemon\'s receipt names the config home it stamped', spawnSelfStamped(field).get('MERCURY_CONFIG_DIR') === home)
const fieldStamps = sessionEnvStamps(field)
tally.check('the stamped config home is a stamp', fieldStamps.includes('MERCURY_CONFIG_DIR'), fieldStamps.join(','))
tally.check('the compile cache that names this home\'s own cache directory is a stamp', fieldStamps.includes(COMPILE_CACHE_ENV), fieldStamps.join(','))
for (const name of ['MHOME', 'MERCURY_WIN32_UTF8_PRESET', 'MERCURY_LAUNCH_ID']) {
  tally.check(`the launcher's ${name} is a stamp`, fieldStamps.includes(name) && LAUNCHER_STAMPS.includes(name))
}
tally.check('an operator pin with no carrier stays', !fieldStamps.includes('MERCURY_MODEL_LANES'))
const fieldScrub = scrubSessionEnvStamps(field)
tally.check('a command sees no parent home, cache or launcher scratch', ['MERCURY_CONFIG_DIR', 'NODE_COMPILE_CACHE', 'MHOME', 'MERCURY_WIN32_UTF8_PRESET', 'MERCURY_LAUNCH_ID'].every(n => fieldScrub.env[n] === undefined), JSON.stringify(fieldScrub.scrubbed))
tally.check('…and keeps the operator pin', fieldScrub.env.MERCURY_MODEL_LANES === '1')

const operator: NodeJS.ProcessEnv = { PATH: process.env.PATH, MERCURY_CONFIG_DIR: home, NODE_COMPILE_CACHE: join(scratch, 'elsewhere', 'cache') }
const operatorStamps = sessionEnvStamps(operator)
tally.check('a config home with no receipt is the operator\'s pin', !operatorStamps.includes('MERCURY_CONFIG_DIR'), operatorStamps.join(','))
tally.check('a compile cache that names another directory is the operator\'s', !operatorStamps.includes(COMPILE_CACHE_ENV), operatorStamps.join(','))
pinHome(`${home}/`)
const trailing: NodeJS.ProcessEnv = { PATH: process.env.PATH, MERCURY_CONFIG_DIR: `${home}/`, NODE_COMPILE_CACHE: join(home, 'compile-cache') }
tally.check('the cache attribution reads the home as the product spells it', sessionEnvStamps(trailing).includes(COMPILE_CACHE_ENV))
pinHome(undefined)
const defaultHome: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_COMPILE_CACHE: join(getMercuryHome(), 'compile-cache') }
tally.check('under the default home the launcher\'s compile cache is a stamp too', sessionEnvStamps(defaultHome).includes(COMPILE_CACHE_ENV))
pinHome(proofHome)

tally.section('§2 the process\'s own write over an operator value hands the operator\'s value back')
resetOwnEnvWritesForTesting()
recordOwnEnvWrite('NODE_PATH', '/operator/modules')
const armed: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_PATH: `${pack}${delimiter}/operator/modules` }
tally.check('the written NODE_PATH is a stamp', sessionEnvStamps(armed).includes('NODE_PATH'))
const armedScrub = scrubSessionEnvStamps(armed)
tally.check('the scrub restores the operator\'s NODE_PATH', armedScrub.env.NODE_PATH === '/operator/modules' && armedScrub.scrubbed.includes('NODE_PATH'), String(armedScrub.env.NODE_PATH))
tally.check('an env that still holds the operator\'s value has nothing to scrub', !sessionEnvStamps({ PATH: process.env.PATH, NODE_PATH: '/operator/modules' }).includes('NODE_PATH'))
resetOwnEnvWritesForTesting()
recordOwnEnvWrite('NODE_PATH', undefined)
recordOwnEnvWrite('NODE_PATH', 'a-later-record-never-wins')
const bare = scrubSessionEnvStamps({ PATH: process.env.PATH, NODE_PATH: pack })
tally.check('a write where the operator had nothing is deleted for the command', bare.env.NODE_PATH === undefined && bare.scrubbed.includes('NODE_PATH'))
resetOwnEnvWritesForTesting()

tally.section('§3 the image pack arm records its NODE_PATH write')
const arm = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'FileReadTool', 'imagePackArm.ts'), 'utf8')
const recordAt = arm.indexOf("recordOwnEnvWrite('NODE_PATH', process.env.NODE_PATH)")
tally.check('armImagePack records the operator\'s NODE_PATH before it writes', recordAt !== -1 && recordAt < arm.indexOf('process.env.NODE_PATH = current'))

tally.section('§4 the owned daemon\'s receipt names the config home it stamps')
const ownedHome = join(scratch, 'owned-home')
const project = join(scratch, 'owned-project')
mkdirSync(ownedHome, { recursive: true })
mkdirSync(project, { recursive: true })
const dumper = join(scratch, 'dump-env.ts')
writeFileSync(dumper, `import { writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nwriteFileSync(join(process.argv[4] ?? '.', 'env.json'), JSON.stringify(process.env))\n`)
const savedHome = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = ownedHome
getMercuryHome.cache.clear()
const { spawnOwnedDaemon } = await import('../../src/daemon/ownedDaemon.ts')
const waitFor = async (path: string, ms: number): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(path)) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return existsSync(path)
}
delete process.env.MERCURY_CONFIG_DIR
getMercuryHome.cache.clear()
process.env.MERCURY_HOME = ownedHome
getMercuryHome.cache.clear()
const pid = spawnOwnedDaemon(project, { node: process.execPath, script: dumper, ownerPipe: false, persist: true, label: 'proof-daemon' })
tally.check('the owned spawn ran the dumper', typeof pid === 'number')
const dumped = await waitFor(join(project, 'env.json'), bound(20_000))
tally.check('the spawned process wrote its environment', dumped)
const spawnedEnv: NodeJS.ProcessEnv = dumped ? (JSON.parse(readFileSync(join(project, 'env.json'), 'utf8')) as NodeJS.ProcessEnv) : {}
tally.check('the daemon carries the resolved config home', spawnedEnv.MERCURY_CONFIG_DIR === getMercuryHome(), String(spawnedEnv.MERCURY_CONFIG_DIR))
tally.check('…and its receipt names it as the spawner\'s stamp', spawnSelfStamped(spawnedEnv).get('MERCURY_CONFIG_DIR') === getMercuryHome(), String(spawnedEnv.MERCURY_SPAWNED_ENV))
tally.check('a worker\'s tool shell scrubs the daemon\'s home from a command', !('MERCURY_CONFIG_DIR' in scrubSessionEnvStamps(spawnedEnv).env))
delete process.env.MERCURY_HOME
process.env.MERCURY_CONFIG_DIR = ownedHome
getMercuryHome.cache.clear()
const pinnedProject = join(scratch, 'pinned-project')
mkdirSync(pinnedProject, { recursive: true })
const pinnedPid = spawnOwnedDaemon(pinnedProject, { node: process.execPath, script: dumper, ownerPipe: false, persist: true, label: 'proof-daemon-pinned' })
tally.check('the pinned spawn ran the dumper', typeof pinnedPid === 'number')
const pinnedDumped = await waitFor(join(pinnedProject, 'env.json'), bound(20_000))
const pinnedEnv: NodeJS.ProcessEnv = pinnedDumped ? (JSON.parse(readFileSync(join(pinnedProject, 'env.json'), 'utf8')) as NodeJS.ProcessEnv) : {}
tally.check('an operator\'s own config-home pin is not in the receipt', pinnedDumped && !spawnSelfStamped(pinnedEnv).has('MERCURY_CONFIG_DIR'), String(pinnedEnv.MERCURY_SPAWNED_ENV))
process.env.MERCURY_CONFIG_DIR = savedHome
getMercuryHome.cache.clear()

tally.section('§5 the built product: a command run by a daemon-spawned session sees no parent home')
const ASK = 'show-env'
const envFile = join(scratch, 'child-env.txt')
let seen: SeenResult | undefined
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: `env > ${JSON.stringify(envFile)}`, description: 'the environment a command sees' } }]
  seen = req.results[req.results.length - 1]
  return [{ type: 'text', text: 'done' }]
})
const runHome = join(scratch, 'run-home')
const cwd = join(scratch, 'work')
seedScratchHome(runHome, cwd)
const env = childEnv(runHome, Number(new URL(fixture.base).port))
env.NODE_COMPILE_CACHE = join(runHome, 'compile-cache')
env.MHOME = runHome
env.MERCURY_LAUNCH_ID = 'cmd-1234-5678'
env.MERCURY_MODEL_LANES = '1'
stampSpawnReceipt(env, ['MERCURY_CONFIG_DIR'])
const turn = await new Promise<{ outcome: Frame | null; code: number | null; stderr: string }>(resolve => {
  const frames: Frame[] = []
  const reader = new LineReader()
  let stderr = ''
  const child = spawn(NODE, [DIST, 'run', '--input', 'rows', '--format', 'rows', '--model', MODEL, '--mode', 'sovereign'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const killer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
  child.stdout.on('data', (chunk: Buffer) => {
    for (const frame of reader.feed(chunk)) {
      frames.push(frame)
      if (frame.type === 'outcome') child.stdin.end()
    }
  })
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  child.on('close', code => {
    clearTimeout(killer)
    frames.push(...reader.flush())
    resolve({ outcome: lastOutcome(frames) ?? null, code, stderr })
  })
  child.stdin.write(inputLine(promptRow(ASK, { id: randomUUID() })))
})
await fixture.close()
tally.check('the run completed', turn.outcome !== null && (turn.outcome as { status?: unknown }).status === 'completed', `exit ${turn.code}: ${turn.stderr.slice(-300)}`)
tally.check('the command ran', seen !== undefined && !seen.isError, seen?.text.slice(0, 200))
const childSeen = new Map<string, string>()
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) childSeen.set(line.slice(0, eq), line.slice(eq + 1))
  }
}
tally.check('the command sees no parent config home', !childSeen.has('MERCURY_CONFIG_DIR'), childSeen.get('MERCURY_CONFIG_DIR'))
tally.check('the command sees no parent compile cache', !childSeen.has('NODE_COMPILE_CACHE'), childSeen.get('NODE_COMPILE_CACHE'))
tally.check('the command sees none of the launcher\'s scratch', !childSeen.has('MHOME') && !childSeen.has('MERCURY_LAUNCH_ID'))
tally.check('the command keeps the operator\'s pin and the MERCURY=1 marker', childSeen.get('MERCURY_MODEL_LANES') === '1' && childSeen.get('MERCURY') === '1')
tally.check('the result names the scrubbed home and cache', (seen?.text ?? '').includes('MERCURY_CONFIG_DIR') && (seen?.text ?? '').includes('NODE_COMPILE_CACHE'), seen?.text.slice(-400))

if (!KEEP) rmSync(scratch, { recursive: true, force: true })
tally.finish()
