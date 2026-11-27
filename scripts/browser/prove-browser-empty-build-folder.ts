#!/usr/bin/env bun
process.env.MERCURY_CREDENTIAL_STORE = 'file'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser, computeExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers'
import { removeScratch } from '../lib/removeScratch.ts'

const SELF = fileURLToPath(import.meta.url)
const [mode, ...rest] = process.argv.slice(2)

const platform = detectBrowserPlatform()
if (!platform) {
  console.log('prove-browser-empty-build-folder: [SKIP] unsupported BrowserPlatform on this host')
  process.exit(0)
}

if (mode === '--child') {
  const [configHome = '', cacheOverride = '', kind = '', buildId = ''] = rest
  process.env.MERCURY_CONFIG_DIR = configHome
  if (cacheOverride === '') delete process.env.MERCURY_BROWSER_CACHE_DIR
  else process.env.MERCURY_BROWSER_CACHE_DIR = cacheOverride
  delete process.env.MERCURY_BROWSER_PATH
  const { browserCacheDir } = await import('../../src/integrations/browser/browserResolver.ts')
  const { installManagedBrowser } = await import('../../src/integrations/browser/browserInstall.ts')
  const cacheDir = browserCacheDir()
  const buildDir = join(cacheDir, Browser.CHROME, `${platform}-${buildId}`)
  const exe = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir, platform })
  let called = 0

  const standIn = async (opts: { cacheDir: string; buildId: string; platform?: ReturnType<typeof detectBrowserPlatform> }): Promise<unknown> => {
    called++
    const targetPlatform = opts.platform ?? platform
    const targetDir = join(opts.cacheDir, Browser.CHROME, `${targetPlatform}-${opts.buildId}`)
    const targetExe = computeExecutablePath({ browser: Browser.CHROME, buildId: opts.buildId, cacheDir: opts.cacheDir, platform: targetPlatform })
    if (kind === 'fail-empty') {
      mkdirSync(targetDir, { recursive: true })
      throw new Error('Extraction failed: no zip archiver is available.')
    }
    if (kind === 'fail-partial') {
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(join(targetDir, 'stray.bin'), 'partial-payload')
      throw new Error('Extraction failed: disk write interrupted.')
    }
    if (existsSync(targetDir) && !existsSync(targetExe)) {
      throw new Error(`The browser folder (${targetDir}) exists but the executable (${targetExe}) is missing. Delete ${targetDir} and install the browser again.`)
    }
    mkdirSync(join(targetExe, '..'), { recursive: true })
    writeFileSync(targetExe, '#!/bin/sh\necho "Chrome for Testing"\n', { mode: 0o755 })
    return { browser: Browser.CHROME, buildId: opts.buildId, platform: targetPlatform, executablePath: targetExe, path: targetDir }
  }

  try {
    const res = kind === 'real'
      ? await installManagedBrowser(buildId)
      : await installManagedBrowser(buildId, undefined, standIn)
    console.log(JSON.stringify({ ok: true, called, cacheDir, buildDir, exe, res, buildDirExists: existsSync(buildDir), exeExists: existsSync(exe) }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(JSON.stringify({ ok: false, called, cacheDir, buildDir, exe, message, buildDirExists: existsSync(buildDir), exeExists: existsSync(exe) }))
  }
  process.exit(0)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix installManagedBrowser in src/integrations/browser/browserInstall.ts`}`)
}
const show = (value: unknown): string => JSON.stringify(value)

type ChildOut = {
  ok: boolean
  called: number
  cacheDir: string
  buildDir: string
  exe: string
  res?: { buildId: string; executablePath: string; sizeBytes: number }
  message?: string
  buildDirExists: boolean
  exeExists: boolean
}

const runChild = (configHome: string, kind: string, buildId: string, cacheOverride = ''): ChildOut => {
  const ran = spawnSync(process.execPath, [SELF, '--child', configHome, cacheOverride, kind, buildId], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CREDENTIAL_STORE: 'file' },
    timeout: 60_000,
  })
  if (ran.status !== 0) throw new Error(`child ${kind} exited ${ran.status}: ${ran.stderr.slice(-400)}`)
  return JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as ChildOut
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'browser-empty-folder-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })

try {
  console.log('============================================================')
  console.log(' Browser install — empty build folder never wedges provision')
  console.log('============================================================')

  console.log('── (a) empty build folder before provision: cleared and lands ──')
  {
    const buildId = '158.0.8127.88'
    const buildDir = join(home, 'browsers', Browser.CHROME, `${platform}-${buildId}`)
    mkdirSync(buildDir, { recursive: true })
    const out = runChild(home, 'land', buildId)
    check('provision over an empty build folder succeeds', out.ok && out.called === 1 && out.exeExists && out.res?.executablePath === out.exe, show(out))
    rmSync(join(home, 'browsers'), { recursive: true, force: true })
  }

  console.log('── (b) non-empty build folder without executable: refused in tool voice, files untouched ──')
  {
    const buildId = '158.0.8127.89'
    const buildDir = join(home, 'browsers', Browser.CHROME, `${platform}-${buildId}`)
    mkdirSync(buildDir, { recursive: true })
    const keepFile = join(buildDir, 'partial.tmp')
    writeFileSync(keepFile, 'half-unpacked-bytes')
    const out = runChild(home, 'land', buildId)
    check('refused before calling the installer library', !out.ok && out.called === 0, show(out))
    check('refusal names /browser remove <build> and not library Delete wording', (out.message ?? '').includes(`/browser remove ${buildId}`) && !(out.message ?? '').includes(`Delete ${buildDir}`), show(out.message))
    check('the folder and its file stay untouched byte for byte', existsSync(keepFile) && readFileSync(keepFile, 'utf8') === 'half-unpacked-bytes', show(out))
    rmSync(join(home, 'browsers'), { recursive: true, force: true })
  }

  console.log('── (c) failed attempt leaves empty folder: swept after failure, next provision lands ──')
  {
    const buildId = '158.0.8127.90'
    const firstTry = runChild(home, 'fail-empty', buildId)
    check('failed attempt propagates its error and leaves no empty build folder behind', !firstTry.ok && firstTry.called === 1 && (firstTry.message ?? '').includes(process.platform === 'linux' ? 'this machine lacks unzip' : 'no zip archiver') && !firstTry.buildDirExists, show(firstTry))
    const secondTry = runChild(home, 'land', buildId)
    check('the retry lands cleanly on the next provision', secondTry.ok && secondTry.called === 1 && secondTry.exeExists, show(secondTry))
    rmSync(join(home, 'browsers'), { recursive: true, force: true })
  }

  console.log('── (d) failed attempt leaves a file in the folder: folder and file stay ──')
  {
    const buildId = '158.0.8127.91'
    const out = runChild(home, 'fail-partial', buildId)
    const stray = join(out.buildDir, 'stray.bin')
    check('failed attempt with a file in the folder leaves folder and file untouched', !out.ok && out.called === 1 && out.buildDirExists && existsSync(stray) && readFileSync(stray, 'utf8') === 'partial-payload', show(out))
    rmSync(join(home, 'browsers'), { recursive: true, force: true })
  }

  console.log('── (e) complete build: untouched, same answer through real library ──')
  {
    const buildId = '158.0.8127.92'
    const cacheDir = join(home, 'browsers')
    const exe = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir, platform })
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, '#!/bin/sh\necho "Chrome for Testing"\n', { mode: 0o755 })
    const out = runChild(home, 'real', buildId)
    check('complete build stays untouched and real install returns it cleanly', out.ok && out.exeExists && out.res?.buildId === buildId && out.res.executablePath === exe && out.res.sizeBytes > 0, show(out))
    rmSync(join(home, 'browsers'), { recursive: true, force: true })
  }

  console.log('── (f) through a profile of a first home and with MERCURY_BROWSER_CACHE_DIR override ──')
  {
    const first = join(scratch, 'first')
    const second = join(scratch, 'second')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(join(second, 'profile.json'), `${JSON.stringify({ first, id: 2 })}\n`)

    const buildId = '158.0.8127.93'
    const firstBuildDir = join(first, 'browsers', Browser.CHROME, `${platform}-${buildId}`)
    mkdirSync(firstBuildDir, { recursive: true })
    const p2Land = runChild(second, 'land', buildId)
    check('Profile 2 clears an empty build folder in the first home store and lands there', p2Land.ok && p2Land.cacheDir === join(first, 'browsers') && p2Land.exeExists && p2Land.exe.startsWith(join(first, 'browsers')), show(p2Land))

    const partialId = '158.0.8127.94'
    const firstPartialDir = join(first, 'browsers', Browser.CHROME, `${platform}-${partialId}`)
    mkdirSync(firstPartialDir, { recursive: true })
    writeFileSync(join(firstPartialDir, 'keep.txt'), 'keep')
    const p2Refuse = runChild(second, 'land', partialId)
    check('Profile 2 refuses a non-empty incomplete folder in the first home with /browser remove and keeps its file', !p2Refuse.ok && p2Refuse.called === 0 && (p2Refuse.message ?? '').includes(`/browser remove ${partialId}`) && existsSync(join(firstPartialDir, 'keep.txt')), show(p2Refuse))

    const override = join(scratch, 'override-cache')
    const overId = '158.0.8127.95'
    const overDir = join(override, Browser.CHROME, `${platform}-${overId}`)
    mkdirSync(overDir, { recursive: true })
    const overLand = runChild(second, 'land', overId, override)
    check('MERCURY_BROWSER_CACHE_DIR override clears empty build folder in override and lands there', overLand.ok && overLand.cacheDir === override && overLand.exeExists && overLand.exe.startsWith(override), show(overLand))
  }
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? '\nprove-browser-empty-build-folder: ALL HOLD' : `\nprove-browser-empty-build-folder: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
