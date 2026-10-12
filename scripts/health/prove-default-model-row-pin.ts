#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, NODE } from '../daemon/dupline-world.ts'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const DEAD = 'http://127.0.0.1:1'
const SCRUB = ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API_KEY']
type Row = { id: string; label: string; status: string; evidence?: string }
const world = realpathSync(mkdtempSync(join(tmpdir(), 'default-model-row-')))

function home(tag: string, settings: Record<string, unknown> | undefined, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; work: string } {
  const root = mkdtempSync(join(world, `${tag}-`))
  const config = join(root, 'config')
  const work = join(root, 'work')
  mkdirSync(config)
  mkdirSync(work)
  if (settings !== undefined) writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'os'),
    MERCURY_CONFIG_DIR: config,
    MERCURY_DAEMON_DIR: join(root, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    ANTHROPIC_API_KEY: 'fixture-anthropic-key',
    ANTHROPIC_BASE_URL: DEAD,
    CI: 'true',
    ...extra,
  }
  for (const name of SCRUB) if (!(name in extra)) delete env[name]
  return { env, work }
}

async function healthRows(h: { env: NodeJS.ProcessEnv; work: string }, args: string[] = []): Promise<{ rows: Row[]; stderr: string; status: number | null }> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'health', '--json', ...args], { cwd: h.work, env: h.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const timer = setTimeout(() => child.kill(), 180_000)
    child.on('close', status => {
      clearTimeout(timer)
      let rows: Row[] = []
      try {
        rows = (JSON.parse(stdout) as { sections: Array<{ checks: Row[] }> }).sections.flatMap(s => s.checks)
      } catch {
        rows = []
      }
      resolve({ rows, stderr, status })
    })
  })
}
const row = (rows: Row[], id: string): Row | undefined => rows.find(r => r.id === id)

section('§1 a settings pin: the Default model row names the model a fresh session really starts on')
{
  const pinned = await healthRows(home('pinned', { engine: { model: 'claude-sonnet-5-5' } }))
  const frontier = row(pinned.rows, 'frontier')
  const pins = row(pinned.rows, 'model')
  check('health --json answered with the two model rows', frontier !== undefined && pins !== undefined, `${pinned.status} ${pinned.stderr.slice(0, 200)}`)
  check('the Model pins row reads the pin as the session model', /^session model claude-sonnet-5-5 = settings pin$/.test(pins?.evidence ?? ''), JSON.stringify(pins))
  check('the Default model row starts on the SAME model (the pin), not the unpinned computed default', /^fresh-session default Sonnet 5\.5 · the settings pin engine\.model — without the pin: /.test(frontier?.evidence ?? ''), JSON.stringify(frontier))
  check('…and still names what the default would be without the pin', /without the pin: \S/.test(frontier?.evidence ?? '') && !/without the pin: fresh-session default/.test(frontier?.evidence ?? ''), JSON.stringify(frontier))
  check('the row keeps its first-party gating detail', typeof (frontier as { detail?: string } | undefined)?.detail === 'string' && /first-party gating: /.test(String((frontier as { detail?: string }).detail)), JSON.stringify(frontier))
}

section('§2 an alias pin resolves and says so')
{
  const alias = await healthRows(home('alias', { engine: { model: 'sonnet' } }))
  const frontier = row(alias.rows, 'frontier')
  check('an alias pin is shown resolved, with the spelling the file holds', /^fresh-session default \S.* · the settings pin engine\.model 'sonnet' \(resolved\) — without the pin: /.test(frontier?.evidence ?? ''), JSON.stringify(frontier))
}

section('§3 MERCURY_MODEL outranks the file and the row says which pin spoke')
{
  const env = await healthRows(home('env', { engine: { model: 'claude-sonnet-5-5' } }, { MERCURY_MODEL: 'claude-opus-4-8' }))
  const frontier = row(env.rows, 'frontier')
  check('the environment pin is named as the source', /^fresh-session default \S.* · MERCURY_MODEL — without the pin: /.test(frontier?.evidence ?? ''), JSON.stringify(frontier))
}

section('§4 no pin: the row reads as before')
{
  const plain = await healthRows(home('plain', undefined))
  const frontier = row(plain.rows, 'frontier')
  const pins = row(plain.rows, 'model')
  check('Model pins says no settings pin', /· no settings pin$/.test(pins?.evidence ?? ''), JSON.stringify(pins))
  check('the Default model row is the computed default alone, with no pin words', /^fresh-session default \S/.test(frontier?.evidence ?? '') && !/the settings pin|without the pin|MERCURY_MODEL/.test(frontier?.evidence ?? ''), JSON.stringify(frontier))
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-default-model-row-pin: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-default-model-row-pin: all green')
