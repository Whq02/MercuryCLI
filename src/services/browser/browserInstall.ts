// ============================================================================
//  services/browser/browserInstall — the EXPLICIT consented install path for
//  the managed Chrome-for-Testing cache.
//
//  LAW: nothing here runs implicitly — the ONLY callers are the operator's
//  /browser install|remove verbs. The download resolves the buildId from
//  Chrome for Testing's AUTHORITATIVE metadata endpoints (via the bundled
//  @puppeteer/browsers), reports version + measured disk cost, and the
//  browser itself NEVER joins release archives (the cache lives under the
//  config home).
// ============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from '@puppeteer/browsers'
import { browserCacheDir, dirSizeBytes, listManagedBrowsers, type ManagedBrowser } from './browserResolver.js'

function requirePlatform(): NonNullable<ReturnType<typeof detectBrowserPlatform>> {
  const p = detectBrowserPlatform()
  if (!p) throw new Error('unsupported platform for the managed browser cache')
  return p
}

/** A bounded race: the CfT metadata endpoint has no timeout of its own, so
 *  offline/filtered networks hung the plan forever — name the deadline. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${what} exceeded its ${ms}ms deadline (offline, or a filtered network?)`)),
        ms,
      )
      ;(t as { unref?: () => void }).unref?.()
    }),
  ])
}

export interface InstallPlan {
  buildId: string
  cacheDir: string
  /** What the operator consents to — shown BEFORE any browser bytes move. */
  consentLine: string
}

/**
 * Resolve the buildId for an install plan: a PINNED buildId needs no network
 * at all (reproduce a teammate's engine, roll back); otherwise the current
 * stable resolves from Chrome for Testing's authoritative metadata (network:
 * metadata only, a few KB, deadline-bounded — the operator's explicit
 * consent step still precedes any browser bytes).
 */
export async function planBrowserInstall(pinnedBuildId?: string): Promise<InstallPlan> {
  const buildId =
    pinnedBuildId ??
    (await withDeadline(
      resolveBuildId(Browser.CHROME, requirePlatform(), 'stable'),
      12_000,
      'resolving the current stable Chrome-for-Testing build',
    ))
  return {
    buildId,
    cacheDir: browserCacheDir(),
    consentLine: `Chrome for Testing ${buildId} (${pinnedBuildId ? 'pinned' : 'stable'}) into ${browserCacheDir()} — typically 150-200 MB on disk; inspect with /browser status, remove any time with /browser remove ${buildId}`,
  }
}

// ── the persisted install plan ──────────────────────────────────────────────
// The two-step consent token used to be module-local memory, which made the
// headless road structurally impossible (plan and confirm run in different
// processes) and mis-diagnosed a fresh process as "expired". The plan lives
// beside the cache it describes; confirm consumes it.

export const INSTALL_PLAN_TTL_MS = 10 * 60 * 1000

function installPlanPath(): string {
  return path.join(browserCacheDir(), '.install-plan.json')
}

export function persistInstallPlan(buildId: string): void {
  fs.mkdirSync(browserCacheDir(), { recursive: true })
  fs.writeFileSync(installPlanPath(), JSON.stringify({ buildId, plannedAt: Date.now() }))
}

export function readPersistedInstallPlan(): { buildId: string; plannedAt: number; expired: boolean } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(installPlanPath(), 'utf8')) as { buildId?: unknown; plannedAt?: unknown }
    if (typeof raw.buildId !== 'string' || typeof raw.plannedAt !== 'number') return null
    return { buildId: raw.buildId, plannedAt: raw.plannedAt, expired: Date.now() - raw.plannedAt > INSTALL_PLAN_TTL_MS }
  } catch {
    return null
  }
}

export function clearPersistedInstallPlan(): void {
  try {
    fs.unlinkSync(installPlanPath())
  } catch {
    /* nothing recorded */
  }
}

export interface InstallResult {
  buildId: string
  executablePath: string
  sizeBytes: number
}

/** The download itself — call ONLY from the consented /browser install verb. */
export async function installManagedBrowser(
  buildId: string,
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<InstallResult> {
  const platform = requirePlatform()
  const cacheDir = browserCacheDir()
  await install({
    browser: Browser.CHROME,
    buildId,
    cacheDir,
    platform,
    downloadProgressCallback: onProgress,
  })
  const executablePath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir, platform })
  const installed: ManagedBrowser | undefined = listManagedBrowsers().find(m => m.buildId === buildId)
  return {
    buildId,
    executablePath,
    sizeBytes: installed?.sizeBytes ?? dirSizeBytes(path.join(cacheDir, 'chrome')),
  }
}
