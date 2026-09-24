import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

export const ROOT = resolve(import.meta.dir, '../..')

export function argAfter(flag: string): string | undefined {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

export const DIST = argAfter('--dist') ?? join(ROOT, 'dist/mercury.mjs')
export const RECORD = argAfter('--record')
export const LEAD_MODEL = 'claude-fable-5-1'
export const LEAD_GATE = 'fable-5-1'
export const TURN_MS = 90_000

const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
export const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'

export type World = {
  dir: string
  config: string
  project: string
  teams: string
  fixture: FixtureApi
  env: NodeJS.ProcessEnv
}

export async function makeWorld(label: string, script: ScriptedTurn[]): Promise<World> {
  if (!existsSync(DIST)) throw new Error(`no bundle at ${DIST} — build the product first`)
  const dir = mkdtempSync(join(tmpdir(), `${label}-`))
  const config = join(dir, 'config')
  const project = join(dir, 'project')
  const teams = join(dir, 'teams')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# fixture\n')
  seedFirstRun(config, [project])
  const fixture = await startFixtureApi(script)
  const env: NodeJS.ProcessEnv = {
    HOME: dir,
    PATH: '/usr/bin:/bin:' + dirname(NODE),
    TERM: 'dumb',
    MERCURY_CONFIG_DIR: config,
    MERCURY_TEAMS_DIR: teams,
    MERCURY_DAEMON_DIR: join(dir, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: fixture.url,
  }
  return { dir, config, project, teams, fixture, env }
}

export type Frame = Record<string, unknown>

export type Session = {
  child: ChildProcess
  frames: Frame[]
  stdout: () => string
  stderr: () => string
  exited: Promise<number | null>
  submit: (text: string) => void
  waitFor: (label: string, test: () => boolean, timeoutMs?: number) => Promise<void>
  end: () => Promise<number | null>
  terminate: () => Promise<number | null>
}

export function bootLead(world: World, extraArgv: string[], allowedTools: string[]): Session {
  const argv = [
    DIST,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--model',
    LEAD_MODEL,
    '--allowed-tools',
    ...allowedTools,
    '--teammate-mode',
    'in-process',
    ...extraArgv,
  ]
  const child = spawn(NODE, argv, { cwd: world.project, env: world.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: Frame[] = []
  let out = ''
  let err = ''
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    out += text
    buffer += text
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() === '') continue
      try {
        frames.push(JSON.parse(line) as Frame)
      } catch {
      }
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8')
  })
  let done = false
  const exited = new Promise<number | null>(resolveExit =>
    child.on('close', code => {
      done = true
      resolveExit(code)
    }),
  )
  const waitFor = async (label: string, test: () => boolean, timeoutMs = TURN_MS): Promise<void> => {
    const until = Date.now() + timeoutMs
    while (!test()) {
      if (done || Date.now() >= until) {
        throw new Error(`${label}\n--- stdout tail ---\n${out.slice(-1500)}\n--- stderr tail ---\n${err.slice(-1500)}`)
      }
      await new Promise(tick => setTimeout(tick, 25))
    }
  }
  return {
    child,
    frames,
    stdout: () => out,
    stderr: () => err,
    exited,
    submit: text => {
      child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    },
    waitFor,
    end: async () => {
      try {
        child.stdin!.end()
      } catch {
      }
      const code = await Promise.race([exited, new Promise<number | null>(r => setTimeout(() => r(null), 60_000))])
      if (!done) child.kill('SIGKILL')
      return code
    },
    terminate: async () => {
      try {
        child.kill('SIGTERM')
      } catch {
      }
      const code = await Promise.race([exited, new Promise<number | null>(r => setTimeout(() => r(null), 60_000))])
      if (!done) child.kill('SIGKILL')
      return code
    },
  }
}

type Block = { type?: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
type Item = { role?: string; content?: unknown }

function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map(part => {
      if (typeof part.text === 'string') return part.text
      if (part.type === 'tool_result') return textOfBlocks(part.content)
      return ''
    })
    .join('\n')
}

export function toolResultOf(world: World, toolUseId: string): { text: string; isError: boolean } | null {
  for (const request of world.fixture.messageRequests()) {
    const body = request.body as { messages?: Item[] } | null
    for (const item of body?.messages ?? []) {
      if (item.role !== 'user' || !Array.isArray(item.content)) continue
      for (const part of item.content as Block[]) {
        if (part.type === 'tool_result' && part.tool_use_id === toolUseId) {
          return { text: textOfBlocks(part.content), isError: part.is_error === true }
        }
      }
    }
  }
  return null
}

export function userTextsOf(world: World, model = LEAD_MODEL): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const request of world.fixture.messageRequests()) {
    const body = request.body as { model?: string; messages?: Item[] } | null
    if (body?.model !== model) continue
    for (const item of body?.messages ?? []) {
      if (item.role !== 'user') continue
      const text = textOfBlocks(item.content)
      if (text === '' || seen.has(text)) continue
      seen.add(text)
      out.push(text)
    }
  }
  return out
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function treeOf(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      out.push(`${prefix}${name}/`)
      out.push(...treeOf(path, `${prefix}${name}/`))
    } else {
      out.push(`${prefix}${name}`)
    }
  }
  return out
}

export function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...findFiles(path, name))
    else if (entry === name) out.push(path)
  }
  return out
}

export function record(name: string, text: string): void {
  if (RECORD === undefined) return
  mkdirSync(RECORD, { recursive: true })
  writeFileSync(join(RECORD, name), text)
}

export function makeTally(name: string): { check: (label: string, cond: boolean, detail?: string) => void; section: (t: string) => void; finish: () => never } {
  let failures = 0
  let checks = 0
  return {
    check(label, cond, detail = '') {
      checks++
      if (!cond) failures++
      console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
    },
    section(t) {
      console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
    },
    finish() {
      console.log(`\n${checks} checks, ${failures} failures`)
      console.log(failures === 0 ? `${name}: ALL LAWS HOLD` : `${name}: ${failures} FAILURE(S)`)
      process.exit(failures === 0 ? 0 : 1)
    },
  }
}

export async function closeWorld(world: World): Promise<void> {
  await world.fixture.close()
  rmSync(world.dir, { recursive: true, force: true })
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
