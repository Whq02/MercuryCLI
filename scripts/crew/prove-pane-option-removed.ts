#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(argument('--root') ?? join(import.meta.dir, '../..'))
const DIST = argument('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const src = (relative: string): string => join(ROOT, 'src', relative)
const read = (relative: string): string => (existsSync(src(relative)) ? readFileSync(src(relative), 'utf8') : '')

section('the pane road is gone from the tree: its files, its backend, its setting rows, its spawn options')
for (const file of [
  'utils/swarm/teammateLayoutManager.ts',
  'utils/swarm/It2SetupPrompt.tsx',
  'utils/swarm/backends/PaneBackendExecutor.ts',
  'utils/swarm/backends/teammateModeSnapshot.ts',
  'utils/swarm/backends/TmuxBackend.ts',
  'utils/swarm/backends/ITermBackend.ts',
  'utils/swarm/backends/it2Setup.ts',
  'utils/swarm/backends/registry.ts',
  'utils/swarm/backends/InProcessBackend.ts',
]) {
  check(`${file} is deleted`, !existsSync(src(file)))
}
const spawnSource = read('tools/shared/spawnMultiAgent.ts')
check('the spawn road has one strategy: in-process (no split pane, no separate window, no backend detection)', spawnSource !== '' && !/spawnSplitPane|spawnSeparateWindow|detectAndGetBackend|createTeammatePaneInSwarmView|sendCommandToPane|use_splitpane/.test(spawnSource))
check('the teammate spawn config carries no pane option', !/use_splitpane\?: boolean/.test(spawnSource))
const main = read('main.tsx')
check('the CLI has no --teammate-mode option', !/--teammate-mode/.test(main) && !/setCliTeammateModeOverride/.test(main))
const config = read('components/Settings/Config.tsx')
check('the settings screen has no teammate mode row', !/teammateMode/.test(config) && !/teammate mode\b/i.test(config))
const schema = read('utils/config/schema.ts')
check('the config schema names no pane mode (the old key is read and ignored, never a word)', !/teammateMode\?:/.test(schema) && !/preferTmuxOverIterm2/.test(schema))
const setup = read('setup.ts')
check('the boot captures no teammate mode snapshot', !/captureTeammateModeSnapshot/.test(setup))
const agentTool = read('tools/AgentTool/AgentTool.tsx')
check('the Agent tool names no pane option', !/splitpane|tmux/i.test(agentTool))
const helpers = read('utils/swarm/teamHelpers.ts')
check('the team helpers kill no panes', !/killPane|isPaneBackend/.test(helpers))
const registryRows = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
check('no flag row names the teammate mode', !/TEAMMATE_MODE/.test(registryRows))
for (const doc of ['docs/TEAMS.md', 'docs/ENGINES.md', 'README.md']) {
  const text = existsSync(join(ROOT, doc)) ? readFileSync(join(ROOT, doc), 'utf8') : ''
  check(`${doc} has no row for the tmux/iTerm pane option`, !/teammateMode|--teammate-mode|split[- ]pane|iTerm2 pane|tmux pane/i.test(text))
}

section('a saved teammateMode: tmux setting boots the built product without a word')
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'pane-removed-'))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })
writeFileSync(join(project, 'README.md'), '# fixture\n')
seedFirstRun(home, [project])
const configPath = join(home, '.mercury.json')
const saved = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>) : {}
writeFileSync(configPath, JSON.stringify({ ...saved, teammateMode: 'tmux', preferTmuxOverIterm2: true }, null, 2))
const lead = 'claude-fable-5-1'
const script: ScriptedTurn[] = [
  { kind: 'text', text: 'LEAD-DONE', model: lead, whenModel: 'fable-5-1' } as ScriptedTurn,
  { kind: 'text', text: 'LEAD-DONE', model: lead, whenModel: 'fable-5-1' } as ScriptedTurn,
]
const fixture = await startFixtureApi(script)
const vendoredNode = join(ROOT, 'dist/vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
const run = await new Promise<{ status: number | null; out: string }>(resolveRun => {
  const child = spawn(node, [DIST, '-p', '--output-format', 'json', '--model', lead, '--permission-mode', 'sovereign', '--', 'say LEAD-DONE'], {
    cwd: project,
    env: {
      HOME: scratch,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: home,
      MERCURY_TEAMS_DIR: join(scratch, 'teams'),
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BOOT_PREFLIGHT: '0',
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: fixture.url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  child.on('close', status => {
    clearTimeout(killer)
    resolveRun({ status, out })
  })
})
await fixture.close()
const out = run.out
check('the product boots and answers with the saved pane setting in place', run.status === 0 && out.includes('LEAD-DONE'), `rc=${run.status} ${out.slice(-600)}`)
check('not a word about the pane mode, tmux or iTerm on the way', !/teammateMode|teammate mode\b|tmux|iTerm|\bit2\b/i.test(out), out.split('\n').filter(l => /teammateMode|teammate mode\b|tmux|iTerm|\bit2\b/i.test(l)).slice(0, 3).join(' | '))
const stillSaved = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
check('the saved setting is untouched (read and ignored, never rewritten away)', stillSaved.teammateMode === 'tmux')
rmSync(scratch, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-pane-option-removed: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
