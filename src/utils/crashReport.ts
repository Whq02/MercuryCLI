
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MERCURY_VERSION } from '../constants/product.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'

const KEEP = 20

export function crashReportDir(): string {
  return join(getMercuryHome(), 'crashes')
}

export function crashReportDirDisplay(): string {
  const dir = crashReportDir()
  const home = homedir()
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
}

let lastReportPath: string | null = null
export function lastCrashReportPath(): string | null {
  return lastReportPath
}

let lastReportRefusal: string | null = null
export function lastCrashReportRefusal(): string | null {
  return lastReportRefusal
}

export function failingComponentOf(componentStack: string | null | undefined): string | null {
  if (!componentStack) return null
  for (const line of componentStack.split('\n')) {
    const m = line.trim().match(/^(?:in|at)\s+([A-Za-z0-9_$.]+)/)
    if (m?.[1]) return m[1]
  }
  return null
}

export type CrashConversation = { sessionId: string; transcriptPath: string | null }

let conversationLocator: (() => CrashConversation | null) | null = null

export function setCrashConversationLocator(locator: (() => CrashConversation | null) | null): void {
  conversationLocator = locator
}

function locateConversation(): CrashConversation | null {
  if (conversationLocator === null) return null
  try {
    const located = conversationLocator()
    return located !== null && located.sessionId !== '' ? located : null
  } catch {
    return null
  }
}

function crashIdentity(): {
  version: string | null
  platform: string
  sessionId: string | null
  transcriptPath: string | null
  cwd: string | null
  surface: string | null
} {
  const conversation = locateConversation()
  let sessionId: string | null = conversation?.sessionId ?? null
  if (sessionId === null) {
    try {
      const { getSessionId } = require('../bootstrap/state.js') as typeof import('../bootstrap/state.js')
      sessionId = String(getSessionId())
    } catch {}
  }
  let cwd: string | null = null
  try {
    const { getCwd } = require('./cwd.js') as typeof import('./cwd.js')
    cwd = getCwd()
  } catch {
    try {
      cwd = process.cwd()
    } catch {
    }
  }
  let surface: string | null = null
  try {
    const { currentSurfaceRoute, surfaceRouteId } =
      require('../context/surfaceRoute.js') as typeof import('../context/surfaceRoute.js')
    surface = surfaceRouteId(currentSurfaceRoute())
  } catch {
  }
  return {
    version: MERCURY_VERSION ?? null,
    platform: `${process.platform}-${process.arch} node ${process.versions.node}`,
    sessionId,
    transcriptPath: conversation?.transcriptPath ?? null,
    cwd,
    surface,
  }
}

export function persistCrashReport(
  error: unknown,
  errorInfo?: { componentStack?: string | null },
  origin: 'app-root' | 'message-boundary' | 'boot' | 'surface' | 'uncaught-exception' | 'unhandled-rejection' | 'settings-popup' = 'app-root',
): void {
  try {
    const dir = crashReportDir()
    mkdirSync(dir, { recursive: true })
    const err = error instanceof Error ? error : new Error(String(error))
    const file = join(dir, `crash-${Date.now()}-${origin}.json`)
    writeFileSync(
      file,
      JSON.stringify(
        {
          origin,
          at: new Date().toISOString(),
          message: err.message,
          stack: err.stack ?? null,
          componentStack: errorInfo?.componentStack ?? null,
          component: failingComponentOf(errorInfo?.componentStack),
          ...crashIdentity(),
          pid: process.pid,
          argv1: process.argv[1] ?? null,
        },
        null,
        2,
      ),
    )
    lastReportPath = file
    lastReportRefusal = null
    try {
      const all = readdirSync(dir)
        .filter(f => f.startsWith('crash-'))
        .sort()
      for (const stale of all.slice(0, Math.max(0, all.length - KEEP))) {
        try {
          rmSync(join(dir, stale), { force: true })
        } catch (pruneErr) {
          logForDebugging(`[crashReport] prune failed for ${stale}: ${pruneErr}`)
        }
      }
    } catch (listErr) {
      logForDebugging(`[crashReport] prune listing failed: ${listErr}`)
    }
  } catch (writeErr) {
    lastReportRefusal = writeErr instanceof Error ? writeErr.message : String(writeErr)
  }
}


export type CrashReportSummary = {
  file: string
  origin: string
  at: string
  message: string
  component: string | null
  sessionId: string | null
  cwd: string | null
  pid: number | null
  transcriptPath: string | null
}

export function listCrashReports(limit = KEEP): CrashReportSummary[] {
  try {
    const dir = crashReportDir()
    const names = readdirSync(dir)
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
    return names.map(name => {
      const file = join(dir, name)
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
          origin?: string
          at?: string
          message?: string
          component?: string | null
          sessionId?: string | null
          cwd?: string | null
          pid?: number | null
          transcriptPath?: string | null
        }
        return {
          file,
          origin: parsed.origin ?? 'unknown',
          at: parsed.at ?? 'unknown',
          message: parsed.message ?? '(no message)',
          component: parsed.component ?? null,
          sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : null,
          cwd: typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : null,
          pid: typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
          transcriptPath: typeof parsed.transcriptPath === 'string' && parsed.transcriptPath !== '' ? parsed.transcriptPath : null,
        }
      } catch {
        return {
          file,
          origin: 'unknown',
          at: 'unknown',
          message: '(unreadable report)',
          component: null,
          sessionId: null,
          cwd: null,
          pid: null,
          transcriptPath: null,
        }
      }
    })
  } catch {
    return []
  }
}

export type CrashTranscriptRoad = 'recorded' | 'report' | 'registry' | 'moved' | 'project'

export type CrashTranscriptResolution = { sessionId: string; transcriptPath: string; road: CrashTranscriptRoad }

export type CrashTranscriptOptions = {
  projectDirOf: (cwd: string) => string
  currentCwd: string
  excludeSessionIds?: readonly string[]
  clearedAt?: (sessionId: string) => number | null
  notAfterMs?: number
  sessionsDir?: string
}

const TRANSCRIPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

function transcriptIfPresent(dir: string, sessionId: string): string | null {
  try {
    const candidate = join(dir, `${sessionId}.jsonl`)
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

function projectDirsOf(report: Pick<CrashReportSummary, 'cwd'>, opts: CrashTranscriptOptions): string[] {
  const dirs: string[] = []
  for (const cwd of [report.cwd, opts.currentCwd]) {
    if (cwd === null || cwd === '') continue
    try {
      const dir = opts.projectDirOf(cwd)
      if (!dirs.includes(dir)) dirs.push(dir)
    } catch {}
  }
  return dirs
}

type TranscriptCandidate = { sessionId: string; transcriptPath: string; mtimeMs: number; bornMs: number }

function transcriptsIn(dir: string, opts: CrashTranscriptOptions): TranscriptCandidate[] {
  const excluded = new Set(opts.excludeSessionIds ?? [])
  const notAfter = opts.notAfterMs ?? Number.POSITIVE_INFINITY
  const out: TranscriptCandidate[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const id = TRANSCRIPT_NAME.exec(name)?.[1]
    if (id === undefined || excluded.has(id)) continue
    try {
      const st = statSync(join(dir, name))
      if (!st.isFile() || st.size === 0) continue
      const bornMs = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs
      if (bornMs > notAfter) continue
      out.push({ sessionId: id, transcriptPath: join(dir, name), mtimeMs: st.mtimeMs, bornMs })
    } catch {}
  }
  return out
}

function registrySession(pid: number, opts: CrashTranscriptOptions): { sessionId: string; cwd: string | null } | null {
  try {
    const file = join(opts.sessionsDir ?? join(getMercuryHome(), 'sessions'), `${pid}.json`)
    const record = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; sessionId?: string; cwd?: string }
    if (record.pid !== pid || typeof record.sessionId !== 'string' || record.sessionId === '') return null
    return { sessionId: record.sessionId, cwd: typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : null }
  } catch {
    return null
  }
}

export function resolveCrashTranscript(
  report: Pick<CrashReportSummary, 'sessionId' | 'cwd' | 'pid' | 'transcriptPath'> & { at?: string },
  opts: CrashTranscriptOptions,
): CrashTranscriptResolution | null {
  const excluded = new Set(opts.excludeSessionIds ?? [])
  if (report.transcriptPath !== null && report.sessionId !== null && !excluded.has(report.sessionId)) {
    try {
      if (statSync(report.transcriptPath).isFile()) {
        return { sessionId: report.sessionId, transcriptPath: report.transcriptPath, road: 'recorded' }
      }
    } catch {}
  }
  const dirs = projectDirsOf(report, opts)
  let cleared: CrashTranscriptResolution | null = null
  if (report.sessionId !== null && !excluded.has(report.sessionId)) {
    const clearedAtMs = opts.clearedAt?.(report.sessionId) ?? null
    for (const dir of dirs) {
      const path = transcriptIfPresent(dir, report.sessionId)
      if (path === null) continue
      const found = { sessionId: report.sessionId, transcriptPath: path, road: 'report' as const }
      if (clearedAtMs === null) return found
      cleared = found
      break
    }
    if (clearedAtMs !== null) {
      let fromId = report.sessionId
      let fromMs = clearedAtMs
      let moved: TranscriptCandidate | undefined
      for (let hop = 0; hop < 12; hop++) {
        let next: TranscriptCandidate | undefined
        for (const dir of dirs) {
          next = transcriptsIn(dir, opts)
            .filter(c => c.sessionId !== fromId && c.bornMs >= fromMs - 1_000)
            .sort((a, b) => a.bornMs - b.bornMs)[0]
          if (next !== undefined) break
        }
        if (next === undefined) break
        moved = next
        const nextMs = opts.clearedAt?.(next.sessionId) ?? null
        if (nextMs === null) break
        fromId = next.sessionId
        fromMs = nextMs
      }
      if (moved !== undefined) return { sessionId: moved.sessionId, transcriptPath: moved.transcriptPath, road: 'moved' }
      if (cleared !== null) return cleared
    }
  }
  if (report.pid !== null) {
    const registered = registrySession(report.pid, opts)
    if (registered !== null && !excluded.has(registered.sessionId)) {
      const registryDirs = registered.cwd !== null ? projectDirsOf({ cwd: registered.cwd }, opts) : dirs
      for (const dir of [...registryDirs, ...dirs]) {
        const path = transcriptIfPresent(dir, registered.sessionId)
        if (path !== null) return { sessionId: registered.sessionId, transcriptPath: path, road: 'registry' }
      }
    }
  }
  const crashProject = report.cwd !== null ? projectDirsOf({ cwd: report.cwd }, { ...opts, currentCwd: report.cwd }) : dirs
  const crashedAtMs = typeof report.at === 'string' ? Date.parse(report.at) : Number.NaN
  const bornBeforeMs = Number.isFinite(crashedAtMs) ? crashedAtMs + 60_000 : Number.POSITIVE_INFINITY
  for (const dir of crashProject) {
    const newest = transcriptsIn(dir, opts)
      .filter(c => c.bornMs <= bornBeforeMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (newest !== undefined) return { sessionId: newest.sessionId, transcriptPath: newest.transcriptPath, road: 'project' }
  }
  return null
}


const NOTICE_MARKER = '.boot-noticed'

export function unnoticedCrashReports(): CrashReportSummary[] {
  try {
    const dir = crashReportDir()
    let noticedAt = 0
    try {
      noticedAt = statSync(join(dir, NOTICE_MARKER)).mtimeMs
    } catch {
    }
    return listCrashReports().filter(report => {
      try {
        return statSync(report.file).mtimeMs > noticedAt
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

export function markCrashReportsNoticed(): void {
  try {
    const dir = crashReportDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, NOTICE_MARKER), new Date().toISOString())
  } catch {
  }
}
