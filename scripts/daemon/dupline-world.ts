import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { hostRunner, type HostedRunner } from '../lib/runnerHost.ts'
import type { Frame } from '../lib/rows.ts'
import type { Capabilities, PermissionAnswer, PermissionRequestParams } from '../../src/runner/wire/methods.ts'

export const REPO = join(import.meta.dir, '..', '..')
export const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
export const DIST = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
export const FRAMES = argAfter('--frames')
export const FIXTURE = join(import.meta.dir, 'dupline-fixture-server.ts')
export const WIN = process.platform === 'win32'
export const BUN = process.env.BUN ?? process.execPath
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', ...(WIN ? ['node.exe'] : ['bin', 'node']))
export const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
export const SCRATCH_ROOT = WIN ? realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir()) : realpathSync(tmpdir())
export { AGENT_DESCRIPTION, AGENT_TURN_ASK, LINE } from './dupline-fixture-words.ts'
export const QUEUED_PLATE = 'queued   [sam]'
export const PROBE_KEY = 'sk-ant-dupline-key'
export const CLOCK_TOLERANCE_MS = 5_000
export const MODEL = 'claude-opus-4-8'

export const j = (v: unknown): string => JSON.stringify(v)
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
export const bound = (ms: number): number => vshotBudgetMs(ms)

export function makeTally(name: string): { check: (label: string, cond: boolean, detail?: string) => void; section: (t: string) => void; finish: () => never; failed: () => number } {
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
    failed: () => failures,
    finish() {
      console.log(`\n${checks} checks, ${failures} failures`)
      console.log(failures === 0 ? `${name}: ALL LAWS HOLD` : `${name}: ${failures} FAILURE(S)`)
      process.exit(failures === 0 ? 0 : 1)
    },
  }
}

export type Rec = { recordId?: string; creationOrdinal?: string; occurredAt?: string; threadId?: string; annotations?: { uuid?: string }; payload?: { kind?: string; attachmentType?: string; metaKind?: string; content?: unknown; fields?: Record<string, unknown>; meta?: Record<string, unknown> } }
export type Carrier = { file: string; kind: string; recordId: string; ordinal: string; occurredAt: string; sourceUuid: string; sentAt: string; deliveredAt: string; thread: string; agentId: string; uuid: string }
export function textOfRecord(r: Rec): string {
  const p = r.payload ?? {}
  if (p.kind === 'input') {
    const c = p.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(b => String((b as { text?: string }).text ?? '')).join('\n')
    return ''
  }
  if (p.kind === 'attachment') return String((p.fields ?? {}).prompt ?? '')
  return ''
}
export function transcriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      if (statSync(p).isDirectory()) out.push(...transcriptFiles(p))
      else if (name.endsWith('.jsonl')) out.push(p)
    } catch {
    }
  }
  return out
}
export function carriersOf(projectsDir: string, line: string): Carrier[] {
  const out: Carrier[] = []
  for (const p of transcriptFiles(projectsDir)) {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const escaped = JSON.stringify(line).slice(1, -1)
    for (const raw of text.split('\n')) {
      if (!raw.includes(line) && !raw.includes(escaped)) continue
      let r: Rec
      try {
        r = JSON.parse(raw) as Rec
      } catch {
        continue
      }
      if (!textOfRecord(r).includes(line)) continue
      const p2 = r.payload ?? {}
      const f = p2.fields ?? {}
      const meta = p2.meta ?? {}
      const agent = /agent-([^/\\]+)\.jsonl$/.exec(p)
      out.push({
        file: relative(projectsDir, p),
        kind: p2.kind === 'attachment' ? `attachment/${p2.attachmentType}` : String(p2.kind),
        recordId: String(r.recordId ?? ''),
        ordinal: String(r.creationOrdinal ?? ''),
        occurredAt: String(r.occurredAt ?? ''),
        sourceUuid: String(f.source_uuid ?? ''),
        sentAt: String(f.sentAt ?? meta.sentAt ?? ''),
        deliveredAt: String(f.deliveredAt ?? meta.deliveredAt ?? ''),
        thread: String(r.threadId ?? ''),
        agentId: agent?.[1] ?? '',
        uuid: String(r.annotations?.uuid ?? meta.uuid ?? ''),
      })
    }
  }
  return out
}
export type QueueJournalRow = { operation: string; content: string; at: string }
export function queueJournal(projectsDir: string): QueueJournalRow[] {
  const out: QueueJournalRow[] = []
  for (const p of transcriptFiles(projectsDir)) {
    if (p.includes('subagents')) continue
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      if (!raw.includes('queue-operation')) continue
      try {
        const r = JSON.parse(raw) as Rec
        const pl = r.payload ?? {}
        if (pl.kind !== 'session-meta' || pl.metaKind !== 'queue-operation') continue
        const f = pl.fields ?? {}
        out.push({ operation: String(f.operation ?? ''), content: typeof f.content === 'string' ? f.content : '', at: String(r.occurredAt ?? '') })
      } catch {
      }
    }
  }
  return out
}
export const inMainFile = (c: Carrier): boolean => !c.file.includes('subagents')
export const isDrainedMainRow = (c: Carrier): boolean => inMainFile(c) && c.kind === 'attachment/queued_command'
export const briefly = (cs: Carrier[]): string => j(cs.map(c => `${c.file.replace(/^.*?[\\/]/, '')} ${c.kind} src=${c.sourceUuid.slice(0, 8)} at=${c.occurredAt}${c.deliveredAt === '' ? '' : ` delivered=${c.deliveredAt}`}`))
export const deliveryClockOf = (c: Carrier): number => Date.parse(c.deliveredAt === '' ? c.occurredAt : c.deliveredAt)
export async function settledCarriers(projectsDir: string, line: string, timeoutMs: number, settled: (cs: Carrier[]) => boolean = cs => cs.some(isDrainedMainRow)): Promise<Carrier[]> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const carriers = carriersOf(projectsDir, line)
    if (settled(carriers) || Date.now() >= until) return carriers
    await sleep(100)
  }
}
export function agentTranscripts(projectsDir: string): Array<{ agentId: string; description: string; file: string }> {
  const out: Array<{ agentId: string; description: string; file: string }> = []
  for (const p of transcriptFiles(projectsDir)) {
    const m = /agent-([^/\\]+)\.jsonl$/.exec(p)
    if (!m || !p.includes('subagents')) continue
    let description = ''
    try {
      const meta = JSON.parse(readFileSync(p.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { description?: string }
      description = String(meta.description ?? '')
    } catch {
    }
    out.push({ agentId: m[1]!, description, file: relative(projectsDir, p) })
  }
  return out
}
export function exportWorld(kind: string, home: string, extra: Record<string, string>): void {
  if (FRAMES === undefined) return
  const dest = join(FRAMES, kind)
  const copy = (from: string, to: string, recursive: boolean): void => {
    if (!existsSync(from)) return
    try {
      cpSync(from, to, { recursive })
    } catch (err) {
      console.log(`  [frames] ${from} not copied: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    mkdirSync(dest, { recursive: true })
    for (const name of ['wire.jsonl', 'connector-trace.jsonl', 'cfg.json', 'grid.json']) copy(join(home, name), join(dest, name), false)
    copy(join(home, 'projects'), join(dest, 'transcripts'), true)
    for (const [name, text] of Object.entries(extra)) writeFileSync(join(dest, name), text)
    console.log(`  [frames] ${kind} world written under ${dest}`)
  } catch (err) {
    console.log(`  [frames] ${kind} world not written: ${err instanceof Error ? err.message : String(err)}`)
  }
}
export async function removeWorld(dir: string): Promise<void> {
  const until = Date.now() + bound(10_000)
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (Date.now() >= until) {
        console.log(`  [cleanup] the world stays at ${dir}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      await sleep(250)
    }
  }
}

export function childEnv(runHome: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: runHome,
    MERCURY_DAEMON_DIR: join(runHome, 'daemon'),
    MERCURY_CREWS_DIR: join(runHome, 'crews'),
    MERCURY_HOME: join(runHome, 'proof-home'),
    MERCURY_HEALTH_STATE_DIR: join(runHome, 'health-state'),
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    MERCURY_STREAM_IDLE_TIMEOUT_MS: '30000',
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CONNECTOR_TRACE: join(runHome, 'connector-trace.jsonl'),
    BROWSER: '/usr/bin/true',
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}
export const configKeyOf = (dir: string): string => (WIN ? dir.replace(/\\/g, '/').replace(/^([a-z]):\//, (_, letter: string) => `${letter.toUpperCase()}:/`) : dir)
export function seedHome(runHome: string, cwd: string): void {
  rmSync(runHome, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(runHome, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [configKeyOf(cwd)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(runHome, 'settings.json'), '{}')
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
}
export type Wire = { kind: string; n: number; arm?: string; step?: number; at: number; ask?: string; askShape?: string; askItem?: string; askSha?: string; counts?: Record<string, number>; firstAt?: Record<string, number>; hasAgentTool?: boolean; hasWorkflowTool?: boolean; hasSleepTool?: boolean; folded?: boolean; lastToolResult?: { isError: boolean; text: string } | null; toolNames?: string[]; usageInput?: number }
export type Fixture = { port: number; kill: () => void; wire: () => Wire[] }
export async function startFixture(captureFile: string, agentSleepSeconds: number, mainSleepSeconds = 6, foldPaceMs = 0, holdFile?: string): Promise<Fixture> {
  writeFileSync(captureFile, '')
  const fixture = spawn(BUN, ['run', FIXTURE, captureFile, String(agentSleepSeconds), String(mainSleepSeconds), String(foldPaceMs), ...(holdFile === undefined ? [] : [holdFile])], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), bound(15_000))
    let buffer = ''
    fixture.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const m = /PORT (\d+)/.exec(buffer)
      if (m) {
        clearTimeout(killer)
        resolve(Number(m[1]))
      }
    })
    fixture.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
  })
  const wire = (): Wire[] =>
    readFileSync(captureFile, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Wire)
  return {
    port,
    wire,
    kill: () => {
      try {
        fixture.kill('SIGTERM')
      } catch {
      }
    },
  }
}
export async function waitWire(wire: () => Wire[], label: string, test: (w: Wire) => boolean, timeoutMs: number): Promise<Wire | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = wire().find(test)
    if (hit !== undefined) return hit
    await sleep(60)
  }
  console.log(`  [wait] ${label}: nothing on the wire within ${timeoutMs} ms`)
  return null
}

export type { Frame } from '../lib/rows.ts'
export { isSession, isOutcome } from '../lib/rows.ts'
export type Runner = {
  proc: ChildProcess
  host: HostedRunner
  frames: Frame[]
  stderr: () => string
  waitFor: (label: string, test: (f: Frame) => boolean, timeoutMs: number, after?: number) => Promise<Frame | null>
  prompt: (text: string, id?: string, sentAt?: string) => Promise<boolean>
  request: HostedRunner['request']
  send: HostedRunner['send']
  note: (frame: Frame) => void
  exited: Promise<number | null>
  stop: (graceMs: number) => Promise<void>
  kill: () => void
}
export type AskHost = 'allow' | ((params: PermissionRequestParams, id: number) => PermissionAnswer | Promise<PermissionAnswer>)
export function bootRunner(args: { cwd: string; env: NodeJS.ProcessEnv; extraArgv?: string[]; capabilities?: Partial<Capabilities>; asks?: AskHost }): Runner {
  const frames: Frame[] = []
  const waiters: Array<{ test: (f: Frame) => boolean; resolve: (f: Frame) => void; reject: (error: Error) => void }> = []
  let stderrText = ''
  const note = (frame: Frame): void => {
    frames.push(frame)
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]!.test(frame)) waiters.splice(i, 1)[0]!.resolve(frame)
  }
  const host = hostRunner({
    node: NODE,
    dist: DIST,
    argv: ['--model', MODEL, '--mode', 'sovereign', ...(args.extraArgv ?? [])],
    cwd: args.cwd,
    env: args.env as Record<string, string | undefined>,
    home: args.env.MERCURY_CONFIG_DIR ?? args.cwd,
    onRow: note,
    onNotification: (method, params) => {
      if (method === 'session/applied') note({ type: 'session/applied', ...(params as Record<string, unknown>) })
    },
  })
  const proc = host.child
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })
  let closedError: Error | undefined
  const exited = host.exited.then(code => {
    closedError = new Error(`runner exited ${code ?? 'without a code'}: ${stderrText.trim()}`)
    for (const waiter of waiters.splice(0)) waiter.reject(closedError)
    host.peer.close('the runner exited')
    return code
  })
  if (args.asks === 'allow') host.onAsk(() => ({ outcome: 'allow' }))
  else if (typeof args.asks === 'function') host.onAsk(args.asks)
  void host.initialize(args.capabilities ?? {}).catch(() => undefined)
  const waitFor = (label: string, test: (f: Frame) => boolean, timeoutMs: number, after = 0): Promise<Frame | null> => {
    const seen = frames.slice(after).find(test)
    if (seen !== undefined) return Promise.resolve(seen)
    if (closedError) return Promise.reject(closedError)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = waiters.findIndex(w => w.resolve === done)
        if (at >= 0) waiters.splice(at, 1)
        console.log(`  [wait] ${label}: nothing within ${timeoutMs} ms`)
        resolve(null)
      }, timeoutMs)
      const done = (f: Frame): void => {
        clearTimeout(timer)
        resolve(f)
      }
      waiters.push({ test, resolve: done, reject: error => { clearTimeout(timer); reject(error) } })
    })
  }
  const kill = (): void => {
    try {
      proc.kill('SIGKILL')
    } catch {
    }
  }
  return {
    proc,
    host,
    frames,
    stderr: () => stderrText,
    waitFor,
    prompt: (text, id = randomUUID(), sentAt) => host.prompt(text, { id, ...(sentAt !== undefined ? { sent_at: sentAt } : {}) }).then(() => true, () => false),
    request: host.request,
    send: host.send,
    note,
    exited,
    stop: async graceMs => {
      host.end()
      await Promise.race([exited, sleep(graceMs)])
      kill()
    },
    kill,
  }
}
export const requestsOf = (wire: () => Wire[]): Wire[] => wire().filter(w => w.kind === 'request')
export const carrying = (ws: Wire[], word: string): Wire[] => ws.filter(w => (w.counts?.[word] ?? 0) > 0)
export const describeRequests = (ws: Wire[], words: string[]): string => j(ws.map(w => [w.n, w.arm, w.step, ...words.map(x => w.counts?.[x] ?? 0)]))
