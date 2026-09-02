
import { execFileSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Browser as CftBrowser, BrowserPlatform, computeExecutablePath } from '@puppeteer/browsers'
import { getMercuryHome } from '../../utils/envUtils.js'
import { whichSync } from '../../utils/which.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type BrowserFamily = 'chrome' | 'edge' | 'chromium' | 'brave' | 'chrome-for-testing'

interface FamilyLocations {
  family: Exclude<BrowserFamily, 'chrome-for-testing'>
  label: string
  darwin: string[]
  linuxBinaries: string[]
  win32: string[]
}

const FAMILIES: FamilyLocations[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linuxBinaries: ['google-chrome', 'google-chrome-stable'],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
  {
    family: 'edge',
    label: 'Microsoft Edge',
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linuxBinaries: ['microsoft-edge', 'microsoft-edge-stable'],
    win32: [
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  },
  {
    family: 'chromium',
    label: 'Chromium',
    darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linuxBinaries: ['chromium', 'chromium-browser'],
    win32: [],
  },
  {
    family: 'brave',
    label: 'Brave',
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linuxBinaries: ['brave-browser', 'brave'],
    win32: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  },
]

export interface InstalledBrowser {
  family: BrowserFamily
  label: string
  executablePath: string
}

export function detectInstalledBrowsers(): InstalledBrowser[] {
  if (flagEnv('MERCURY_BROWSER_NO_DISCOVERY') === '1') return []
  const platform = os.platform()
  const found: InstalledBrowser[] = []
  for (const fam of FAMILIES) {
    if (platform === 'darwin' || platform === 'win32') {
      const candidates = platform === 'darwin' ? fam.darwin : fam.win32
      for (const p of candidates) {
        if (existsSync(p)) {
          found.push({ family: fam.family, label: fam.label, executablePath: p })
          break
        }
      }
    } else {
      for (const bin of fam.linuxBinaries) {
        const p = whichSync(bin)
        if (p) {
          found.push({ family: fam.family, label: fam.label, executablePath: p })
          break
        }
      }
    }
  }
  return found
}

export function browserCacheDir(): string {
  const override = flagEnv('MERCURY_BROWSER_CACHE_DIR')
  if (override && override !== '') return override
  return path.join(getMercuryHome(), 'browsers')
}

export interface ManagedBrowser {
  buildId: string
  executablePath: string
  sizeBytes: number
}

export function listManagedBrowsers(): ManagedBrowser[] {
  const cacheRoot = browserCacheDir()
  const root = path.join(cacheRoot, 'chrome')
  if (!existsSync(root)) return []
  const out: ManagedBrowser[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const buildId = entry.name.replace(/^[a-z0-9_]+-/, '')
    const dir = path.join(root, entry.name)
    const exe = findChromeExecutable(cacheRoot, entry.name, dir)
    if (!exe) continue
    out.push({ buildId, executablePath: exe, sizeBytes: dirSizeBytes(dir) })
  }
  return out.sort((a, b) => compareBuildIdsDesc(a.buildId, b.buildId))
}

export function compareBuildIdsDesc(a: string, b: string): number {
  const as = a.split('.').map(n => Number(n))
  const bs = b.split('.').map(n => Number(n))
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = Number.isFinite(as[i]) ? as[i]! : -1
    const bv = Number.isFinite(bs[i]) ? bs[i]! : -1
    if (av !== bv) return bv - av
  }
  return 0
}

function findChromeExecutable(cacheRoot: string, entryName: string, dir: string): string | null {
  const m = /^([a-z0-9_]+)-(.+)$/.exec(entryName)
  if (m) {
    const platform = m[1] as BrowserPlatform
    if ((Object.values(BrowserPlatform) as string[]).includes(platform)) {
      try {
        const derived = computeExecutablePath({
          browser: CftBrowser.CHROME,
          buildId: m[2]!,
          cacheDir: cacheRoot,
          platform,
        })
        if (existsSync(derived)) return derived
      } catch {
      }
    }
  }
  const platform = os.platform()
  const candidates =
    platform === 'darwin'
      ? [
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ]
      : platform === 'win32'
        ? ['chrome-win64/chrome.exe', 'chrome-win32/chrome.exe']
        : ['chrome-linux64/chrome', 'chrome-linux-arm64/chrome']
  for (const rel of candidates) {
    const p = path.join(dir, rel)
    if (existsSync(p)) return p
  }
  return null
}

export function dirSizeBytes(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try {
          total += statSync(p).size
        } catch {
        }
      }
    }
  }
  return total
}

export function removeManagedBrowser(buildId: string): boolean {
  const root = path.join(browserCacheDir(), 'chrome')
  if (!existsSync(root)) return false
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(`-${buildId}`)) {
      rmSync(path.join(root, entry.name), { recursive: true, force: true })
      return true
    }
  }
  return false
}

const DRIVER_NODE_FLOOR = [22, 12, 0] as const

export function driverNodeGate(): { ok: true } | { ok: false; note: string } {
  const parts = process.versions.node.split('.').map(n => Number(n))
  const [a = 0, b = 0] = parts
  const ok = a > DRIVER_NODE_FLOOR[0] || (a === DRIVER_NODE_FLOOR[0] && b >= DRIVER_NODE_FLOOR[1])
  if (ok) return { ok: true }
  return {
    ok: false,
    note: `the bundled browser driver (puppeteer-core) needs node >= ${DRIVER_NODE_FLOOR.join('.')} — this runtime is ${process.versions.node}; upgrade node to use Browser drive ops (discovery/status stay live)`,
  }
}

export interface BrowserResolution {
  state: 'ok'
  source: 'operator-pin' | 'installed' | 'managed-cache'
  family: BrowserFamily
  label: string
  executablePath: string
  buildId?: string
}

export interface BrowserUnavailable {
  state: 'unavailable'
  note: string
  remedies: string[]
}

export function resolveBrowser(): BrowserResolution | BrowserUnavailable {
  const pin = flagEnv('MERCURY_BROWSER_PATH')
  if (pin && pin !== '') {
    if (existsSync(pin)) {
      return { state: 'ok', source: 'operator-pin', family: 'chrome', label: `operator pin`, executablePath: pin }
    }
    return {
      state: 'unavailable',
      note: `MERCURY_BROWSER_PATH set but ${pin} does not exist — the pin names itself, no silent fallback`,
      remedies: ['fix or unset MERCURY_BROWSER_PATH'],
    }
  }
  const installed = detectInstalledBrowsers()
  if (installed.length > 0) {
    const first = installed[0]!
    return {
      state: 'ok',
      source: 'installed',
      family: first.family,
      label: first.label,
      executablePath: first.executablePath,
    }
  }
  const managed = listManagedBrowsers()
  if (managed.length > 0) {
    const newest = managed[0]!
    return {
      state: 'ok',
      source: 'managed-cache',
      family: 'chrome-for-testing',
      label: `Chrome for Testing ${newest.buildId}`,
      executablePath: newest.executablePath,
      buildId: newest.buildId,
    }
  }
  return {
    state: 'unavailable',
    note: 'no browser: nothing installed at the standard locations and the managed cache is empty',
    remedies: [
      'op:"provision" — a consented download of a Chrome-for-Testing build into the managed cache (the ask names the build and disk cost; /browser install is the same road by hand)',
      'ask the operator to install Chrome, Edge, Chromium or Brave normally',
    ],
  }
}

export function browserVersionOf(executablePath: string): string | null {
  try {
    const out = execFileSync(executablePath, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000, env: { ...subprocessEnv() } })
    return out.trim() || null
  } catch {
    return null
  }
}
