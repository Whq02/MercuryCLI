#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs, resolveCaptureDriver } from '../lib/captureDriver.ts'
import { childEnv, startFixture } from '../daemon/dupline-world.ts'
import { AGENT_COLORS, AGENT_COLOR_TO_THEME_COLOR } from '../../src/tools/AgentTool/agentColorManager.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const vendoredNode = join(BIN, '../vendor/node/bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : 'node'
if (!existsSync(BIN)) throw new Error('dist/mercury.mjs missing — run the build first')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') throw new Error(`capture driver unavailable: ${driver.kind}`)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Payload = { grid: Grid; marks?: Array<{ label: string; grid: Grid }>; endReason: string }
const gridText = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))
const headerRow = (grid: Grid): string => gridText(grid).find(row => row.includes('✶ VIEW')) ?? ''
const composer = (grid: Grid): Grid => grid.slice(grid.length - 5, grid.length - 2)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'rename-hosted-'))

async function capture(cols: number, rows: number): Promise<Record<string, Grid>> {
  const tag = `${cols}x${rows}`
  const world = join(scratch, tag)
  const cwd = join(world, 'fixture-cwd')
  const home = join(world, 'home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home)
  seedFirstRun(home, [cwd])
  const fixture = await startFixture(join(world, 'wire.jsonl'), 1, 1)
  const env: NodeJS.ProcessEnv = {
    ...childEnv(home, fixture.port),
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    MERCURY_CRITTER: 'clam',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_AWAY_SUMMARY: '0',
    USER: 'sam', TERM: 'xterm-256color', TERM_PROGRAM: 'vscode',
  }
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'CI', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN']) delete env[key]
  const cfgPath = join(world, 'cfg.json')
  const outPath = join(world, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({
    argv: [NODE, BIN, '--chat'], cwd, cols, rows, total: 400,
    sends: [
      { data: '\r', awaitText: '↑↓ choose', requireAwait: true, minTick: 20, awaitSettleTicks: 5 },
      { data: '/rename roomie\r', awaitText: 'ready ·', targetText: '⇧← back', requireAwait: true, awaitSettleTicks: 8, mark: 'idle' },
      { data: 'hello fixture\r', awaitText: 'Renamed this session to roomie', requireAwait: true, awaitSettleTicks: 8, mark: 'renamed' },
      { data: '', awaitText: 'heard: hello fixture', requireAwait: true, awaitSettleTicks: 6 },
      { data: '/rename a-longer-session-title\r', awaitText: 'ready ·', requireAwait: true, awaitSettleTicks: 6, mark: 'after-turn' },
      { data: '/rename x\r', awaitText: 'Renamed this session to a-longer-session-title', requireAwait: true, awaitSettleTicks: 8, mark: 'long-title' },
      { data: '', awaitText: 'Renamed this session to x', requireAwait: true, awaitSettleTicks: 8, mark: 'short-title' },
    ],
    readyText: ['Renamed this session to x'], readySettleTicks: 4, out: outPath,
  }))
  try {
    const stderr: string[] = []
    const child = spawn(driver.python, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
    child.stderr.on('data', chunk => stderr.push(String(chunk)))
    const code = await new Promise<number>(resolve => child.once('close', value => resolve(value ?? 1)))
    clearTimeout(deadline)
    if (code !== 0 || !existsSync(outPath)) throw new Error(`${tag}: vshot exit ${code}: ${stderr.join('').slice(-600)}`)
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as Payload
    const marks = Object.fromEntries((payload.marks ?? []).map(mark => [mark.label, mark.grid]))
    check(`${tag}: a real turn reached the fixture`, fixture.wire().some(row => row.kind === 'request'))
    if (FRAMES !== undefined) {
      mkdirSync(FRAMES, { recursive: true })
      for (const [name, grid] of Object.entries(marks)) {
        const base = join(FRAMES, `${tag}-${name}`)
        writeFileSync(`${base}.json`, JSON.stringify({ cols, rows, grid }))
        writeFileSync(`${base}.txt`, gridText(grid).join('\n') + '\n')
      }
    }
    return marks
  } finally {
    fixture.kill()
  }
}

function bannerLaws(): void {
  const source = readFileSync(join(REPO, 'src/components/PromptInput/useSwarmBanner.ts'), 'utf8')
  const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')).replaceAll('export ', '')
  const run = (state: Record<string, unknown>, cockpit: boolean, insideTmux: boolean | null = null, teammateMode = 'in-process'): unknown => {
    const bindings = {
      useContext: () => cockpit,
      CockpitActiveContext: {},
      useEffect: () => {},
      useState: () => [insideTmux, () => {}],
      useAppStateStore: () => ({ getState: () => state }),
      useAppState: (select: (value: unknown) => unknown) => select(state),
      getViewedAgent: () => state.viewedAgent,
      getViewedTeammateTask: () => state.viewedTeammate,
      AGENT_COLORS, AGENT_COLOR_TO_THEME_COLOR,
      getAgentColor: () => AGENT_COLOR_TO_THEME_COLOR.green,
      TEAMMATE_COLOR_ENV_VAR: 'agent-color',
      getSwarmSocketName: () => 'fixture-socket',
      isInsideTmux: async () => insideTmux,
      getTeammateModeFromSnapshot: () => teammateMode,
      process: { env: {} },
    }
    return new Function(...Object.keys(bindings), `${body}\nreturn useSwarmBanner()`)(...Object.values(bindings))
  }
  const renamed = { standaloneAgentContext: { name: 'roomie', color: 'blue' } }
  check('a renamed cockpit has no destination banner', run(renamed, true) === null)
  check('a renamed inline session keeps its name and custom colour', same(run(renamed, false), { text: 'roomie', bgColor: AGENT_COLOR_TO_THEME_COLOR.blue }))
  check('a renamed inline session without a colour keeps its fallback', same(run({ standaloneAgentContext: { name: 'roomie' } }, false), { text: 'roomie', bgColor: 'suggestion' }))
  const teammate = { ...renamed, teamContext: { isLeader: false, selfAgentName: 'helper', teamName: 'project', selfAgentColor: 'blue' } }
  const leader = { ...renamed, teamContext: { isLeader: true, teamName: 'project', teammates: { helper: {} } }, viewedTeammate: { identity: { agentName: 'helper', color: 'blue' } } }
  for (const cockpit of [false, true]) {
    check(`teammate process banner survives with cockpit=${cockpit}`, same(run(teammate, cockpit, false, 'tmux'), { text: 'helper', bgColor: AGENT_COLOR_TO_THEME_COLOR.blue }))
    check(`leader attach banner survives with cockpit=${cockpit}`, same(run(leader, cockpit, false, 'tmux'), { text: 'attach: tmux -L fixture-socket attach', bgColor: AGENT_COLOR_TO_THEME_COLOR.blue }))
    check(`leader viewed-teammate banner survives with cockpit=${cockpit}`, same(run(leader, cockpit, true, 'tmux'), { text: 'helper', bgColor: AGENT_COLOR_TO_THEME_COLOR.blue }))
    check(`in-process viewed-teammate banner survives with cockpit=${cockpit}`, same(run(leader, cockpit), { text: 'helper', bgColor: AGENT_COLOR_TO_THEME_COLOR.blue }))
    check(`viewed local agent banner survives with cockpit=${cockpit}`, same(run({ ...renamed, viewedAgent: { name: 'helper', agentType: 'fixture' } }, cockpit), { text: '@helper', bgColor: AGENT_COLOR_TO_THEME_COLOR.green }))
    check(`CLI agent banner survives with cockpit=${cockpit}`, same(run({ mainThreadAgentDefinition: { name: 'helper' } }, cockpit), { text: 'helper', bgColor: 'promptBorder' }))
  }
}

console.log('/rename keeps the hosted composer and names the session — real bundle, PTY')
bannerLaws()
try {
  for (const [cols, rows] of [[178, 51], [120, 40]] as const) {
    const marks = await capture(cols, rows)
    const idle = marks.idle!
    check(`${cols}×${rows}: R1 the idle title reads new session`, headerRow(idle).includes('new session'))
    const frame = composer(idle)
    check(`${cols}×${rows}: the initial composer is rounded`, frame[0]?.[0]?.c === '╭' && frame[2]?.[0]?.c === '╰' && frame[1]?.[0]?.c === '│')
    for (const [mark, name] of [['renamed', 'roomie'], ['long-title', 'a-longer-session-title'], ['short-title', 'x']] as const) {
      const grid = marks[mark]!
      check(`${cols}×${rows}: R2 the VIEW header carries ${name}`, headerRow(grid).split('✶ VIEW')[1]?.split('│')[0]?.trim() === name)
      check(`${cols}×${rows}: R3 the receipt carries ${name}`, gridText(grid).some(row => row.includes(`Renamed this session to ${name}`)))
      check(`${cols}×${rows}: all three composer rows stay cell-identical after ${mark}`, same(composer(grid), frame))
    }
    check(`${cols}×${rows}: the turn leaves the rounded composer in place`, same(composer(marks['after-turn']!), frame))
  }
} catch (error) {
  check('the journey completed', false, String(error))
} finally {
  if (failures === 0) rmSync(scratch, { recursive: true, force: true })
  else console.log(`scratch kept: ${scratch}`)
}
console.log(`prove-rename-hosted-drive: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
