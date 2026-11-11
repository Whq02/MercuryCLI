import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, childEnv, DIST, endLeg, finish, nonLoopback, netlines, productNode, requireCaptureDriver, ROOT, scratch, startLeg } from '../computer/computerDriveKit.js'
import { captureEngineEntry, vshotBudgetMs } from '../lib/captureDriver.js'
import { encodeSeedTranscript } from '../lib/seedTranscript.js'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const frames = arg('--frames')
if (frames !== undefined) mkdirSync(frames, { recursive: true })
const sizes = (arg('--sizes') ?? '80x24,120x40,178x51').split(',').map(size => size.split('x').map(Number) as [number, number])
const driver = requireCaptureDriver('resume-first-status')
const savedModel = 'claude-opus-4-8'
const savedName = 'Opus 4.8'
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.js')
const { sessionFactsPath } = await import('../../src/services/engine-connector/seatProjections.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const run = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number; stderr: string }> => new Promise(resolve => {
  execFile(argv[0]!, argv.slice(1), { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stderr }))
})
for (const parked of [false, true]) for (const [cols, rows] of sizes) {
  const tag = `${parked ? 'parked' : 'bare'}-${cols}x${rows}`
  const work = join(scratch, `work-${tag}`)
  mkdirSync(work)
  const leg = await startLeg(`resume-${tag}`, [], null, work)
  const env = childEnv(leg, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off', MERCURY_REDUCED_MOTION: '1', MERCURY_SESSION_FACTS_HOLD_MS: '2000', MERCURY_TMPDIR: join(leg.home, 'tmp') })
  process.env.MERCURY_CONFIG_DIR = leg.home
  const sid = '00000000-0000-4000-8000-000000000081'
  const directory = getProjectDir(work)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${sid}.jsonl`), encodeSeedTranscript([
    { type: 'user', uuid: '00000000-0000-4000-8000-000000000082', parentUuid: null, sessionId: sid, cwd: work, timestamp: '2026-06-19T12:00:00.000Z', message: { role: 'user', content: 'saved conversation' } },
    { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000083', parentUuid: '00000000-0000-4000-8000-000000000082', sessionId: sid, cwd: work, timestamp: '2026-06-19T12:00:01.000Z', message: { id: 'saved-answer', type: 'message', role: 'assistant', model: savedModel, content: [{ type: 'text', text: 'saved reply' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } } },
  ], sid))
  if (parked) {
    const daemon = join(leg.home, 'daemon')
    mkdirSync(join(daemon, 'session-facts'), { recursive: true })
    writeFileSync(join(daemon, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { 'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: sid, workspaceId: work, isolation: 'shared', modelKey: savedModel, spawnedAt: 900, lastLiveAt: 1000, parkedAt: 1050, parkedBy: 'operator:fixture' } } }))
    writeFileSync(sessionFactsPath(sid, daemon), JSON.stringify({ schema: 1, sessionId: sid, atMs: 1000, model: { effective: 'claude-sonnet-5', setting: 'claude-sonnet-5' }, pendingModel: null, busy: false, usage: noSessionConnector().usage(), identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], workspace: { cwd: work, originalCwd: work, projectRoot: work }, queue: [] }))
  }
  const grid = join(scratch, `${tag}-grid.json`)
  const tee = join(scratch, `${tag}.tee`)
  const cfg = join(scratch, `${tag}-capture.json`)
  writeFileSync(cfg, JSON.stringify({ argv: [productNode(), DIST, '--resume', sid], cwd: work, cols, rows, sends: [], total: 180, readyText: [`ready · ${savedName}`, 'saved reply'], readySettleTicks: 20, out: grid }))
  try {
    const result = await run([driver.python, captureEngineEntry(driver, ROOT), cfg], work, { ...env, VSHOT_TEE: tee }, vshotBudgetMs(70_000))
    const payload = existsSync(grid) ? JSON.parse(readFileSync(grid, 'utf8')) : null
    check(`${tag}: the resumed bundle reaches the saved conversation`, result.code === 0 && payload?.endReason === 'ready', result.stderr.slice(-400))
    const painted = JSON.parse(execFileSync(driver.python, ['-c', `import json, re, struct, sys, pyte
screen = pyte.Screen(int(sys.argv[2]), int(sys.argv[3]))
stream = pyte.ByteStream(screen)
frames = []
with open(sys.argv[1], 'rb') as source:
    while True:
        header = source.read(8)
        if len(header) < 8:
            break
        tick, count = struct.unpack('>II', header)
        stream.feed(source.read(count))
        lines = [line.rstrip() for line in screen.display]
        status = next((line for line in lines if '← back' in line and re.search('ready|runner is starting', line)), None) if int(sys.argv[2]) >= 100 else next((line for line in lines if '✶ Mercury' in line), None)
        if status is not None and (not frames or frames[-1]['status'] != status):
            frames.append({'status': status, 'lines': lines})
print(json.dumps(frames))`, tee, String(cols), String(rows)], { encoding: 'utf8' })) as Array<{ status: string; lines: string[] }>
    const statuses = painted.map(frame => frame.status)
    console.log(`${tag} status sequence: ${JSON.stringify(statuses.map(line => line.trim()))}`)
    check(`${tag}: at least one status row was observed at the emission boundary`, statuses.length > 0)
    check(`${tag}: every model-bearing status names the saved model`, statuses.every(line => !/Opus|Fable|Sonnet/.test(line) || line.includes(savedName)), statuses.join('\n'))
    check(`${tag}: the first model-bearing status names the saved model`, statuses.find(line => /Opus|Fable|Sonnet/.test(line))?.includes(savedName) === true, statuses.join('\n'))
    const firstStarting = statuses.findIndex(line => line.includes('runner is starting'))
    const firstReady = statuses.findIndex(line => /\bready\b/.test(line))
    if (cols >= 100) check(`${tag}: readiness never precedes the runner's starting state`, firstStarting >= 0 && firstReady > firstStarting, statuses.join('\n'))
    else check(`${tag}: the compact header keeps its saved-model ready row without a starting detour`, firstReady >= 0 && firstStarting === -1 && statuses.every(line => line.includes(savedName)), statuses.join('\n'))
    check(`${tag}: after reaching ready the status never goes back to starting`, firstReady >= 0 && statuses.slice(firstReady).every(line => !line.includes('runner is starting')), statuses.join('\n'))
    check(`${tag}: reopening the record stays on loopback`, nonLoopback(netlines(leg.netlog)).length === 0)
    if (frames !== undefined) {
      writeFileSync(join(frames, `${tag}-statuses.json`), JSON.stringify(statuses, null, 2) + '\n')
      painted.forEach((frame, index) => writeFileSync(join(frames, `${tag}-${index}.txt`), frame.lines.join('\n') + '\n'))
    }
  } finally {
    await run([productNode(), DIST, 'daemon', 'stop'], work, env, 30_000)
    await endLeg(leg)
  }
}
finish('resume-first-status')
