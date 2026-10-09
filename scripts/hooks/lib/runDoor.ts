import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../../lib/fixtureApi.ts'

export type Row = Record<string, unknown>

export type RunDoorResult = {
  code: number | null
  rows: Row[]
  stdout: string
  stderr: string
  tookMs: number
  sessionRows: Row[]
  requests: number
}

export type RunDoorScene = {
  turns: ScriptedTurn[]
  hooks: Record<string, Array<Record<string, unknown>>>
  prompt?: string
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number
  signalAfterMs?: { ms: number; signal: NodeJS.Signals }
  beforeRun?: (paths: { home: string; cwd: string }) => void
}

export const dist = process.env.MERCURY_HOOK_ROWS_DIST ?? join(import.meta.dir, '../../../dist/mercury.mjs')

export function sceneRoot(prefix: string): { root: string; home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { root, home, cwd }
}

export const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
export const say = (json: Record<string, unknown>): string => `echo ${quote(JSON.stringify(json))}`

export function sessionFilesOf(home: string): Row[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.jsonl')) files.push(path)
    }
  }
  walk(join(home, 'projects'))
  const rows: Row[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line) as Row)
      } catch {}
    }
  }
  return rows
}

export async function runDoor(paths: { home: string; cwd: string }, scene: RunDoorScene): Promise<RunDoorResult> {
  const fixture = await startFixtureApi(scene.turns)
  writeFileSync(join(paths.home, 'settings.json'), JSON.stringify({ events: { hooks: scene.hooks } }))
  scene.beforeRun?.(paths)
  let stdout = ''
  let stderr = ''
  const started = Date.now()
  const child = spawn('node', [dist, 'run', '--format', 'rows', ...(scene.args ?? []), scene.prompt ?? 'a fixture prompt'], {
    cwd: paths.cwd,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: paths.home,
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
      ANTHROPIC_BASE_URL: fixture.url,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_TRUST_DIALOG_ACCEPTED: '1',
      ...(scene.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', bytes => { stdout += String(bytes) })
  child.stderr.on('data', bytes => { stderr += String(bytes) })
  const guard = setTimeout(() => { child.kill('SIGKILL') }, scene.timeoutMs ?? 90_000)
  const poke = scene.signalAfterMs ? setTimeout(() => { child.kill(scene.signalAfterMs!.signal) }, scene.signalAfterMs.ms) : undefined
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  clearTimeout(guard)
  if (poke) clearTimeout(poke)
  const tookMs = Date.now() - started
  const requests = fixture.messageRequests().length
  await fixture.close()
  const rows: Row[] = stdout.trim().split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line) as Row
    } catch {
      return { bad: line }
    }
  })
  return { code, rows, stdout, stderr, tookMs, sessionRows: sessionFilesOf(paths.home), requests }
}

export type SavedHookRow = { recordId: string; parentId?: string; ordinal: number; fields: Row }

export function savedHookRowsOf(sessionRows: Row[]): SavedHookRow[] {
  const out: SavedHookRow[] = []
  for (const row of sessionRows) {
    const payload = row.payload as Row | undefined
    if (!payload || payload.kind !== 'attachment' || payload.attachmentType !== 'hook') continue
    out.push({ recordId: String(row.recordId), parentId: typeof row.parentId === 'string' ? row.parentId : undefined, ordinal: Number(row.creationOrdinal), fields: payload.fields as Row })
  }
  return out
}

export function payloadKindsOf(sessionRows: Row[]): string[] {
  return sessionRows.map(row => {
    const payload = row.payload as Row | undefined
    if (!payload) return 'none'
    if (payload.kind === 'attachment') return `attachment:${String(payload.attachmentType)}`
    return String(payload.kind)
  })
}
