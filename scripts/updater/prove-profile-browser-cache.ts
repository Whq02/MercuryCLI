#!/usr/bin/env bun
process.env.MERCURY_CREDENTIAL_STORE = 'file'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser as CftBrowser, computeExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'

const SELF = fileURLToPath(import.meta.url)
const [mode, userHome = '', ...rest] = process.argv.slice(2)

if (mode === undefined) {
  if (process.platform === 'win32') {
    console.log('prove-profile-browser-cache: [SKIP] the scene stages the POSIX source deploy')
    process.exit(0)
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'profile-browser-cache-')))
  const home = join(scratch, 'user')
  mkdirSync(home)
  try {
    const child = spawnSync(process.execPath, [SELF, '--scene', home], {
      stdio: 'inherit',
      env: { ...process.env, HOME: home, USERPROFILE: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_BROWSER_CACHE_DIR: '', MERCURY_BROWSER_PATH: '' },
    })
    process.exit(child.status ?? 1)
  } finally {
    removeScratch(scratch)
  }
}

if (userHome === '' || homedir() !== userHome) {
  console.error(`prove-profile-browser-cache: SAFETY: the scratch HOME ${userHome} was not in place before this process started (the home is ${homedir()}); nothing was run`)
  process.exit(1)
}

if (mode === '--probe') {
  const [configHome = '', cacheOverride = '', action = 'read', buildArg = ''] = rest
  process.env.MERCURY_CONFIG_DIR = configHome
  if (cacheOverride === '') delete process.env.MERCURY_BROWSER_CACHE_DIR
  else process.env.MERCURY_BROWSER_CACHE_DIR = cacheOverride
  delete process.env.MERCURY_BROWSER_PATH
  const { browserCacheDir, describeBrowserReadiness, listManagedBrowsers, resolveBrowser } = await import('../../src/integrations/browser/browserResolver.ts')
  const { clearPersistedInstallPlan, installPlanLines, persistInstallPlan, planBrowserInstall, readPersistedInstallPlan } = await import('../../src/integrations/browser/browserInstall.ts')
  const { browserProfileDirForOrigin } = await import('../../src/integrations/browser/session/launch.ts')
  const { call: browserCommand } = await import('../../src/commands/browser/browserCommand.ts')
  type CommandCtx = Parameters<typeof browserCommand>[1]
  const ctx = {} as CommandCtx

  if (action === 'read') {
    const plan = buildArg ? await planBrowserInstall(buildArg) : null
    const status = await browserCommand('status', ctx)
    console.log(JSON.stringify({
      cacheDir: browserCacheDir(),
      resolution: resolveBrowser(),
      readiness: describeBrowserReadiness(),
      managed: listManagedBrowsers(),
      plan,
      planLines: plan ? installPlanLines(plan) : [],
      persisted: readPersistedInstallPlan(),
      profileDir: browserProfileDirForOrigin('https://example.com'),
      status: status.type === 'text' ? status.value : status.type,
    }))
    process.exit(0)
  }
  if (action === 'install-plan') {
    const out = await browserCommand(`install ${buildArg}`, ctx)
    console.log(JSON.stringify({ out: out.type === 'text' ? out.value : out.type, persisted: readPersistedInstallPlan() }))
    process.exit(0)
  }
  if (action === 'install-confirm') {
    const out = await browserCommand('install confirm', ctx)
    console.log(JSON.stringify({ out: out.type === 'text' ? out.value : out.type, persisted: readPersistedInstallPlan() }))
    process.exit(0)
  }
  if (action === 'persist') {
    persistInstallPlan(buildArg)
    console.log(JSON.stringify({ persisted: readPersistedInstallPlan() }))
    process.exit(0)
  }
  if (action === 'clear') {
    clearPersistedInstallPlan()
    console.log(JSON.stringify({ persisted: readPersistedInstallPlan() }))
    process.exit(0)
  }
  process.exit(2)
}

const platform = detectBrowserPlatform()
if (!platform) {
  console.log('prove-profile-browser-cache: [SKIP] unsupported BrowserPlatform on this host')
  process.exit(0)
}

const first = join(userHome, '.mercury')
const second = `${first}2`
process.env.MERCURY_CONFIG_DIR = first
delete process.env.MERCURY_BROWSER_CACHE_DIR
delete process.env.MERCURY_BROWSER_PATH
process.argv[1] = stageInstall('source', userHome).bundle
const { createProfile } = await import('../../src/platform/profiles/profiles.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix browserCacheDir in src/integrations/browser/browserResolver.ts or installPlanPath in src/integrations/browser/browserInstall.ts`}`)
}
const show = (value: unknown): string => JSON.stringify(value)

type ProbeResult = {
  cacheDir?: string
  resolution?: { state: string; source?: string; buildId?: string; executablePath?: string }
  readiness?: { ready: boolean; line: string }
  managed?: Array<{ buildId: string; executablePath: string; sizeBytes: number }>
  plan?: { buildId: string; cacheDir: string; consentLine: string } | null
  planLines?: string[]
  persisted?: { buildId: string; plannedAt: number; expired: boolean } | null
  profileDir?: string | null
  status?: string
  out?: string
}

const probe = (configHome: string, action: string, buildArg = '', cacheOverride = ''): ProbeResult => {
  const ran = spawnSync(process.execPath, [SELF, '--probe', userHome, configHome, cacheOverride, action, buildArg], {
    encoding: 'utf8',
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome, MERCURY_CREDENTIAL_STORE: 'file' },
    timeout: 60_000,
  })
  if (ran.status !== 0) throw new Error(`probe ${action} failed under ${configHome}: ${ran.stderr.slice(-400)}`)
  return JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as ProbeResult
}

const stageBuild = (cacheRoot: string, buildId: string): string => {
  const exe = computeExecutablePath({ browser: CftBrowser.CHROME, buildId, cacheDir: cacheRoot, platform })
  mkdirSync(join(exe, '..'), { recursive: true })
  writeFileSync(exe, '#!/bin/sh\necho "Chrome for Testing"\n', { mode: 0o755 })
  return exe
}

console.log('============================================================')
console.log(' Profiles — shared browser builds, per-profile consent')
console.log('============================================================')

const made = createProfile()
check('Profile 2 is created the product way beside Profile 1', made.ok && made.profile.home === second && existsSync(join(second, 'profile.json')), show(made))

console.log('── (a) first home holds a build: profile resolves it without asking ──')
{
  const buildId = '154.0.7100.10'
  const firstExe = stageBuild(join(first, 'browsers'), buildId)
  const ownOldExe = stageBuild(join(second, 'browsers'), '158.0.8127.88')
  const p2 = probe(second, 'read')
  check('Profile 2 cacheDir is Profile 1 browsers folder', p2.cacheDir === join(first, 'browsers'), show(p2.cacheDir))
  check('Profile 2 resolves Profile 1 build with no download needed', p2.resolution?.state === 'ok' && p2.resolution.source === 'managed-cache' && p2.resolution.buildId === buildId && p2.resolution.executablePath === firstExe, show(p2.resolution))
  check('Profile 2 readiness says ready and points at Profile 1 browsers folder', p2.readiness?.ready === true && p2.readiness.line.includes(join(first, 'browsers')), show(p2.readiness))
  check('/browser status in Profile 2 lists Profile 1 build path', (p2.status ?? '').includes(firstExe) && (p2.status ?? '').includes(buildId), p2.status ?? '')
  check('Profile 2 browsing userDataDir stays under Profile 2 own home', (p2.profileDir ?? '').startsWith(join(second, 'browser-profiles')), show(p2.profileDir))
  check('an earlier per-profile copy under Profile 2 is left untouched on disk and not read', existsSync(ownOldExe) && p2.managed?.every(m => m.buildId !== '158.0.8127.88') === true, show(p2.managed))
  rmSync(join(first, 'browsers'), { recursive: true, force: true })
  rmSync(join(second, 'browsers'), { recursive: true, force: true })
}

console.log('── (b) neither home holds a build: profile plans into first home, first home resolves it ──')
{
  const buildId = '142.0.7444.99'
  const p2Empty = probe(second, 'read', buildId)
  check('Profile 2 sees unavailable when neither home holds a build', p2Empty.resolution?.state === 'unavailable', show(p2Empty.resolution))
  check('Profile 2 install plan targets Profile 1 browsers folder and consent lines name it', p2Empty.plan?.cacheDir === join(first, 'browsers') && (p2Empty.planLines ?? []).some(line => line.includes(join(first, 'browsers'))), show([p2Empty.plan, p2Empty.planLines]))
  const landedExe = stageBuild(p2Empty.plan?.cacheDir ?? '', buildId)
  const p1After = probe(first, 'read')
  const p2After = probe(second, 'read')
  check('Profile 1 resolves the build that landed in its store with no ask', p1After.resolution?.state === 'ok' && p1After.resolution.buildId === buildId && p1After.resolution.executablePath === landedExe, show(p1After.resolution))
  check('Profile 2 resolves that same build under Profile 1', p2After.resolution?.state === 'ok' && p2After.resolution.buildId === buildId && p2After.resolution.executablePath === landedExe && landedExe.startsWith(join(first, 'browsers')), show(p2After.resolution))
  rmSync(join(first, 'browsers'), { recursive: true, force: true })
}

console.log('── (c) pending install consent stays per profile ──')
{
  const p1Plan = probe(first, 'install-plan', '142.0.7444.99')
  check('Profile 1 writes its pending plan under Profile 1 browsers folder', p1Plan.persisted?.buildId === '142.0.7444.99' && existsSync(join(first, 'browsers', '.install-plan.json')) && !existsSync(join(second, 'browsers', '.install-plan.json')), show(p1Plan))
  const p2Confirm = probe(second, 'install-confirm')
  check('Profile 2 cannot see or confirm Profile 1 pending plan', (p2Confirm.out ?? '').includes('no install plan recorded') && existsSync(join(first, 'browsers', '.install-plan.json')), show(p2Confirm))
  const p2Plan = probe(second, 'install-plan', '143.0.7500.1')
  check('Profile 2 writes its own pending plan under Profile 2 browsers folder without overwriting Profile 1', p2Plan.persisted?.buildId === '143.0.7500.1' && existsSync(join(second, 'browsers', '.install-plan.json')) && probe(first, 'read').persisted?.buildId === '142.0.7444.99', show(p2Plan))
  probe(first, 'clear')
  const p1Confirm = probe(first, 'install-confirm')
  check('clearing Profile 1 plan leaves Profile 2 plan standing and Profile 1 cannot confirm Profile 2 plan', (p1Confirm.out ?? '').includes('no install plan recorded') && probe(second, 'read').persisted?.buildId === '143.0.7500.1', show(p1Confirm))
  probe(second, 'clear')
}

console.log('── (d) first home removed while profile marker stands: falls back to own home, never recreates first ──')
{
  rmSync(first, { recursive: true, force: true })
  const p2Gone = probe(second, 'read', '144.0.7600.2')
  check('Profile 2 falls back to its own browsers folder when first home is gone', p2Gone.cacheDir === join(second, 'browsers') && p2Gone.plan?.cacheDir === join(second, 'browsers') && !existsSync(first), show([p2Gone.cacheDir, p2Gone.plan, existsSync(first)]))
  const ownExe = stageBuild(p2Gone.plan?.cacheDir ?? '', '144.0.7600.2')
  probe(second, 'persist', '144.0.7600.2')
  const p2Own = probe(second, 'read')
  check('Profile 2 resolves and persists plan under its own home without recreating first home', p2Own.resolution?.state === 'ok' && p2Own.resolution.executablePath === ownExe && p2Own.persisted?.buildId === '144.0.7600.2' && !existsSync(first), show([p2Own.resolution, p2Own.persisted, existsSync(first)]))
  rmSync(join(second, 'browsers'), { recursive: true, force: true })
  mkdirSync(first, { recursive: true })
  writeFileSync(join(second, 'profile.json'), '{not-json')
  const p2Corrupt = probe(second, 'read')
  check('damaged profile.json falls back to Profile 2 own browsers folder without throwing', p2Corrupt.cacheDir === join(second, 'browsers'), show(p2Corrupt.cacheDir))
  writeFileSync(join(second, 'profile.json'), `${JSON.stringify({ first, id: 2 })}\n`)
}

console.log('── (e) MERCURY_BROWSER_CACHE_DIR override wins for both builds and plan ──')
{
  const override = join(userHome, 'custom-browser-cache')
  const overExe = stageBuild(override, '145.0.7700.3')
  probe(second, 'persist', '145.0.7700.3', override)
  const p2Over = probe(second, 'read', '145.0.7700.3', override)
  check('override wins for cacheDir, build resolution, and plan file', p2Over.cacheDir === override && p2Over.resolution?.executablePath === overExe && p2Over.persisted?.buildId === '145.0.7700.3' && existsSync(join(override, '.install-plan.json')), show(p2Over))
  rmSync(override, { recursive: true, force: true })
}

console.log('── (f) one home alone (no profile.json): unchanged byte for byte ──')
{
  const solo = join(userHome, 'solo-home')
  mkdirSync(solo, { recursive: true })
  const soloExe = stageBuild(join(solo, 'browsers'), '146.0.7800.4')
  probe(solo, 'persist', '146.0.7800.4')
  const s = probe(solo, 'read', '146.0.7800.4')
  check('standalone home resolves builds and plan under its own browsers folder unchanged', s.cacheDir === join(solo, 'browsers') && s.resolution?.executablePath === soloExe && s.persisted?.buildId === '146.0.7800.4' && existsSync(join(solo, 'browsers', '.install-plan.json')) && (s.profileDir ?? '').startsWith(join(solo, 'browser-profiles')), show(s))
}

console.log(failures === 0 ? '\nprove-profile-browser-cache: ALL HOLD' : `\nprove-profile-browser-cache: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
