#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { ALL_MODEL_CONFIGS, newestGenerationKey } from '../../src/utils/model/configs.ts'

const DEFAULT_OPUS = ALL_MODEL_CONFIGS[newestGenerationKey('opus')].firstParty

const SCRATCH = mkdtempSync(join(tmpdir(), 'cmd-privacy-drive-'))
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work-alpha')
for (const d of [daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
process.env.MERCURY_CONCOURSE = 'always'

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const countingTurn = (n: number) => ({
  kind: 'paced_tool_use' as const,
  preDeltas: [`counting ${String(n).padStart(3, '0')} `, 'still going '],
  gapMs: 500,
  tools: [{ name: 'Bash', input: { command: `sleep 4; echo tick-${n}`, description: 'one counted beat' } }],
  whenModel: 'opus',
})
const api = await startFixtureApi([
  ...Array.from({ length: 16 }, (_, i) => countingTurn(i + 1)),
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
let daemon: ReturnType<typeof spawn> | null = null
const spawnDaemon = (configHome: string): void => {
  process.env.MERCURY_CONFIG_DIR = configHome
  daemon = spawn('node', [DIST, 'daemon', 'run', work], {
    cwd: work,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_DAEMON_DIR: daemonDir,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', logFd, logFd],
  })
}
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

let alphaId = ''
let arenaCwd = ''
const { runArtifactArena, grabScreens } = await import('../streaming/artifactArena.ts')
const run = await runArtifactArena({
  turns: [],
  sends: [
    'after:Alpha count:2500:\t',
    'after:Alpha count:4000:\r',
    'after:Alpha count:5200:\r',
    'after:Alpha count:9000:/effort low',
    'after:Alpha count:10500:\r',
    'after:Alpha count:14000:/crew',
    'after:Alpha count:15500:\r',
    'after:Alpha count:20000:/concourse',
    'after:Alpha count:21500:\r',
  ],
  seconds: 42,
  cols: 120,
  rows: 40,
  keep: true,
  seedHome: async (configDir, _cwd) => {
    arenaCwd = _cwd
    seedFirstRun(configDir, [_cwd, work])
    spawnDaemon(configDir)
    check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
    const a = (await daemonControlRpc({
      op: 'concourseDispatch',
      clientMessageId: 'privdrive-alpha',
      prompt: 'count slowly with sleeps',
      workspaceDir: _cwd,
      title: 'Alpha count',
      modelKey: DEFAULT_OPUS,
      effort: 'xhigh',
    } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
    check('alpha dispatched', a.ok === true, JSON.stringify(a))
    alphaId = a.sessionId ?? ''
    const alphaTranscript = join(paths.getProjectDir(_cwd), `${alphaId}.jsonl`)
    check('alpha transcript born', await untilAsync(() => existsSync(alphaTranscript) && statSync(alphaTranscript).size > 100, 30_000))
  },
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_CACHE_CLOCK: '0',
  },
})
try {
  const grabs = grabScreens(run, 120, 40, [8000, 12000, 14000, 17000, 24000, 32000, 40000].map(m => S(m)))
  const KEEP_DIR = process.env.MERCURY_PRIVACY_CAPTURE_DIR
  if (KEEP_DIR) {
    mkdirSync(KEEP_DIR, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    for (const g of grabs) {
      writeFileSync(join(KEEP_DIR, `at${String(g.atMs).padStart(6, '0')}.txt`), g.rows.map((r: string) => r.replace(/\s+$/, '')).join('\n'))
    }
  }
  const text = (g: { rows: string[] }): string => g.rows.join('\n')

  const settingsPath = join(process.env.MERCURY_CONFIG_DIR!, 'settings.json')
  const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as { engine?: { effort?: string } }) : {}
  check("§1 the command EXECUTED on the screen's own home: /effort low saved the default (settings.json engine.effort = low)", settings.engine?.effort === 'low', JSON.stringify(settings.engine ?? null))

  const transcriptPath = join(paths.getProjectDir(arenaCwd), `${alphaId}.jsonl`)
  const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : ''
  check('§2 the session transcript exists and carries the counting turn', transcript.includes('counting'), transcriptPath)
  check('§2 NO transcript byte carries the /effort line (poison: the persisted user row)', !transcript.includes('/effort low') && !transcript.includes('command-message>effort'), '')
  check('§2 NO transcript byte carries the /crew line', !transcript.includes('/crew') && !transcript.includes('command-message>crew'), '')

  const wireHits = api.requests.filter((r: { raw: string }) => r.raw.includes('/effort low') || r.raw.includes('/crew')).length
  check('§3 the wire saw NO request carrying either line', wireHits === 0, `${wireHits} of ${api.requests.length}`)

  const chatFrames = grabs.filter(g => g.atMs >= S(12000) && g.atMs <= S(17000))
  check('§4 the /effort receipt painted on the status row (its tail survives the row\'s fit: "… Saved as your default for future sessions.")', chatFrames.some(g => /Saved as your default for future sessions/.test(text(g))), chatFrames.map(g => `${g.atMs}: ${text(g).split('\n').filter(r => /[Ee]ffort/.test(r)).join(' | ').trim().slice(0, 160)}`).join(' · '))
  const crewFrames = grabs.filter(g => g.atMs >= S(15000) && g.atMs <= S(24000))
  check(
    '§4 the /crew directory painted as the chat receipt',
    crewFrames.some(g => /sources: identity|the crew directory is empty/.test(text(g))),
    crewFrames.map(g => String(g.atMs)).join(','),
  )
  check('§4 the steering queue NEVER took the line (no counted steer or next-turn hold carries the note)', !grabs.some(g => (/\d+ folds? in at the next step/.test(text(g)) || /\d+ waits? for the next turn/.test(text(g))) && /\/effort low/.test(text(g))), '')
} finally {
  run.cleanup()
}

try {
  await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
} catch {
}
daemon?.kill('SIGTERM')
await api.close()

console.log(failures === 0 ? '\nprove-command-privacy-drive: ALL LAWS HOLD' : `\nprove-command-privacy-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
