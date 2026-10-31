import assert from 'node:assert/strict'
import { spawnCaptureSync } from '../lib/spawnCapture.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getProjectDir } from '../../src/utils/sessionStoragePortable.ts'
import { open } from '../../src/services/crewBoard/store.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { gridToPng } from '../ui/gridToPng.ts'

const root = resolve(import.meta.dir, '../..')
const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? join(home, 'frames') : resolve(process.argv[at + 1]!)
mkdirSync(frames, { recursive: true })
const project = join(home, 'project')
mkdirSync(project, { recursive: true })
seedFirstRun(home, [project])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))
const sid = '00000000-aaaa-4000-8000-000000000002'
const storeDir = getProjectDir(project)
mkdirSync(storeDir, { recursive: true })
const base = { isSidechain: false, entrypoint: 'cli', cwd: project, sessionId: sid, version: '1.0.0', gitBranch: 'main' }
writeFileSync(join(storeDir, `${sid}.jsonl`), encodeSeedTranscript([
  { ...base, type: 'user', parentUuid: null, uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-10-30T12:00:00.000Z', message: { role: 'user', content: 'Compare the parser and transport changes.' } },
  { ...base, type: 'assistant', parentUuid: '00000000-0000-4000-8000-000000000001', uuid: '00000000-0000-4000-8000-000000000002', timestamp: '2026-10-30T12:00:01.000Z', message: { id: 'scene-answer', type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'The crew is comparing the two changes.' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 12 } } },
  { ...base, type: 'swarm-switch', on: true },
], sid))
const board = open(join(storeDir, sid, 'boards', 'wave', 'board.sqlite'), sid, () => Date.parse('2026-10-30T12:00:02.000Z'))
for (const [agentId, taskId, text] of [
  ['lead', 'parser', 'Which fields identify a resumed run?'],
  ['parser', 'parser', 'The run id and its cursor identify the saved position.'],
  ['transport', 'transport', 'I will check that the next packet keeps both fields.'],
]) {
  const principal = { author: { sessionId: sid, agentId: agentId!, executionId: agentId! }, name: agentId! }
  board.enroll(principal)
  assert(board.post(principal, { clientOpId: agentId!, kind: 'ask', text: text!, taskId }).ok)
}
board.close()
for (const [cols, rows] of [[120, 44], [80, 24]]) {
  const tag = `${cols}x${rows}`
  const grid = join(frames, `swarm-${tag}.json`)
  const config = join(home, `capture-${tag}.json`)
  writeFileSync(config, JSON.stringify({
    argv: [join(root, 'dist/vendor/node/bin/node'), join(root, 'dist/mercury.mjs'), '--resume', sid, '--model', 'claude-fable-5-1'],
    sends: [
      { data: '/crewmates', atTick: 999, awaitText: 'Type a prompt', requireAwait: true, minTick: 5, awaitSettleTicks: 3 },
      { data: '\r', atTick: 999, awaitText: '/crewmates', requireAwait: true, minTick: 5, awaitSettleTicks: 2 },
      { data: '\t', atTick: 999, awaitText: 'tab Board', requireAwait: true, minTick: 5, awaitSettleTicks: 3 },
    ],
    readyText: ['Which fields identify'], stableTicks: 5, total: 220, cols, rows, out: grid,
  }))
  const capture = spawnCaptureSync('/usr/bin/python3', [join(root, 'scripts/ui/vshot.py'), config], {
    cwd: project, encoding: 'utf8', timeout: vshotBudgetMs(90000),
    env: { ...process.env, HOME: home, USER: 'operator', LOGNAME: 'operator', MERCURY_OPERATOR: 'operator', MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, `daemon-${tag}`), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_LAUNCH_RIPPLE: '0', ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
  })
  assert.equal(capture.status, 0, `${capture.stdout}\n${capture.stderr}`)
  const cells = JSON.parse(readFileSync(grid, 'utf8')).grid as { c: string }[][]
  const screen = cells.map(line => line.map(cell => cell.c).join('')).join('\n')
  assert(screen.includes('Board') && screen.includes('Which fields identify'), screen)
  assert(!screen.includes('verified') && !screen.includes('phase one') && !screen.includes('experimental'), screen)
  const png = join(frames, `swarm-${tag}.png`)
  await gridToPng(grid, png)
  console.log(`PASS built Board ${tag}: ${png}`)
}
