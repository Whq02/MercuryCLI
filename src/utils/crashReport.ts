
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

function crashIdentity(): {
  version: string | null
  platform: string
  sessionId: string | null
  cwd: string | null
  surface: string | null
} {
  let sessionId: string | null = null
  try {
    const { getSessionId } = require('../bootstrap/state.js') as typeof import('../bootstrap/state.js')
    sessionId = String(getSessionId())
  } catch {
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
    cwd,
    surface,
  }
}

export function persistCrashReport(
  error: unknown,
  errorInfo?: { componentStack?: string | null },
  origin: 'app-root' | 'message-boundary' | 'boot' | 'surface' | 'uncaught-exception' | 'unhandled-rejection' = 'app-root',
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
        }
        return {
          file,
          origin: parsed.origin ?? 'unknown',
          at: parsed.at ?? 'unknown',
          message: parsed.message ?? '(no message)',
          component: parsed.component ?? null,
          sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : null,
          cwd: typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : null,
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
        }
      }
    })
  } catch {
    return []
  }
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
