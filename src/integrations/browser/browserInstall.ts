import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  getDownloadUrl,
  install,
  resolveBuildId,
} from '@puppeteer/browsers'
import { installFailure } from './browserLibraries.js'
import { browserCacheDir, browserPlanDir, dirSizeBytes, listManagedBrowsers, type ManagedBrowser } from './browserResolver.js'
import { withDeadline } from '../../platform/async/deadline.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function requirePlatform(): NonNullable<ReturnType<typeof detectBrowserPlatform>> {
  const p = detectBrowserPlatform()
  if (!p) throw new Error('unsupported platform for the managed browser cache')
  return p
}

const STABLE_BUILD_DEADLINE_MS = 12_000

interface InstallPlan {
  buildId: string
  cacheDir: string
  pinned: boolean
  downloadBytes: number | null
  consentLine: string
}

function downloadSizeWords(bytes: number | null, pinned: boolean): string {
  if (bytes !== null) return `a ${(bytes / 1024 / 1024).toFixed(0)} MB download`
  return pinned ? 'download size not checked for a pinned build' : 'download size unknown (the archive did not answer a size)'
}

export function installPlanLines(plan: InstallPlan): string[] {
  return [
    `Chrome for Testing ${plan.buildId} (${plan.pinned ? 'pinned build' : 'current stable'}) — ${downloadSizeWords(plan.downloadBytes, plan.pinned)}`,
    `It unpacks to roughly twice that on disk, under ${plan.cacheDir}`,
    `Remove any time with /browser remove ${plan.buildId}`,
  ]
}

async function probeDownloadBytes(buildId: string): Promise<number | null> {
  try {
    const url = getDownloadUrl(Browser.CHROME, requirePlatform(), buildId)
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) })
    const length = Number(head.headers.get('content-length'))
    return head.ok && Number.isFinite(length) && length > 0 ? length : null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export async function planBrowserInstall(pinnedBuildId?: string): Promise<InstallPlan> {
  const buildId =
    pinnedBuildId ??
    (await withDeadline(
      resolveBuildId(Browser.CHROME, requirePlatform(), 'stable'),
      STABLE_BUILD_DEADLINE_MS,
      () => {
        throw new Error(`resolving the current stable Chrome-for-Testing build exceeded its ${STABLE_BUILD_DEADLINE_MS}ms deadline (offline, or a filtered network?)`)
      },
      { unref: true },
    ))
  const pinned = pinnedBuildId !== undefined
  const downloadBytes = pinned ? null : await probeDownloadBytes(buildId)
  const cacheDir = browserCacheDir()
  const plan: InstallPlan = {
    buildId,
    cacheDir,
    pinned,
    downloadBytes,
    consentLine: `Chrome for Testing ${buildId} (${pinned ? 'pinned build' : 'current stable'}): ${downloadSizeWords(downloadBytes, pinned)}, unpacking to roughly twice that on disk under ${cacheDir}; remove any time with /browser remove ${buildId}`,
  }
  return plan
}


export const INSTALL_PLAN_TTL_MS = 10 * 60 * 1000

function installPlanPath(): string {
  return path.join(browserPlanDir(), '.install-plan.json')
}

export function persistInstallPlan(buildId: string): void {
  fs.mkdirSync(browserPlanDir(), { recursive: true })
  fs.writeFileSync(installPlanPath(), JSON.stringify({ buildId, plannedAt: Date.now() }))
}

export function readPersistedInstallPlan(): { buildId: string; plannedAt: number; expired: boolean } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(installPlanPath(), 'utf8')) as { buildId?: unknown; plannedAt?: unknown }
    if (typeof raw.buildId !== 'string' || typeof raw.plannedAt !== 'number') return null
    return { buildId: raw.buildId, plannedAt: raw.plannedAt, expired: Date.now() - raw.plannedAt > INSTALL_PLAN_TTL_MS }
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function clearPersistedInstallPlan(): void {
  try {
    fs.unlinkSync(installPlanPath())
  } catch (error) {
    passedOver(error)
  }
}

interface InstallResult {
  buildId: string
  executablePath: string
  sizeBytes: number
}

type BrowserInstaller = (options: {
  browser: Browser
  buildId: string
  cacheDir: string
  platform: NonNullable<ReturnType<typeof detectBrowserPlatform>>
  downloadProgressCallback?: (downloadedBytes: number, totalBytes: number) => void
}) => Promise<unknown>

function removeIfEmptyDir(dir: string): void {
  try {
    fs.rmdirSync(dir)
  } catch (error) {
    passedOver(error)
  }
}

export async function installManagedBrowser(
  buildId: string,
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
  installer: BrowserInstaller = install,
): Promise<InstallResult> {
  const platform = requirePlatform()
  const cacheDir = browserCacheDir()
  const buildDir = path.join(cacheDir, Browser.CHROME, `${platform}-${buildId}`)
  const executablePath = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir, platform })
  removeIfEmptyDir(buildDir)
  if (fs.existsSync(buildDir) && !fs.existsSync(executablePath)) {
    throw new Error(
      `incomplete Chrome for Testing ${buildId} build at ${buildDir} (executable missing) — run /browser remove ${buildId}, then provision again`,
    )
  }
  try {
    await installer({
      browser: Browser.CHROME,
      buildId,
      cacheDir,
      platform,
      downloadProgressCallback: onProgress,
    })
  } catch (error) {
    removeIfEmptyDir(buildDir)
    throw await installFailure(error)
  }
  const installed: ManagedBrowser | undefined = listManagedBrowsers().find(m => m.buildId === buildId)
  return {
    buildId,
    executablePath,
    sizeBytes: installed?.sizeBytes ?? dirSizeBytes(path.join(cacheDir, 'chrome')),
  }
}
