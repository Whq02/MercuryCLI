#!/usr/bin/env bun

import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser as CftBrowser, BrowserPlatform, computeExecutablePath } from '@puppeteer/browsers'


let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const CACHE = mkdtempSync(join(tmpdir(), 'mercury-provision-'))
process.env.MERCURY_BROWSER_CACHE_DIR = CACHE
process.env.MERCURY_BROWSER ??= '1'

const { listManagedBrowsers } = await import('../../src/integrations/browser/browserResolver.ts')
const {
  INSTALL_PLAN_TTL_MS,
  clearPersistedInstallPlan,
  persistInstallPlan,
  planBrowserInstall,
  readPersistedInstallPlan,
} = await import('../../src/integrations/browser/browserInstall.ts')
const { call: browserCommand } = await import('../../src/commands/browser/browserCommand.ts')
type CommandCtx = Parameters<typeof browserCommand>[1]
const ctx = {} as CommandCtx

console.log('§1 cache layout round trip (every BrowserPlatform)')
{
  const platforms = Object.values(BrowserPlatform)
  const wanted = new Map<string, string>()
  for (const [i, platform] of platforms.entries()) {
    const buildId = `150.0.700${i}.0`
    const exe = computeExecutablePath({ browser: CftBrowser.CHROME, buildId, cacheDir: CACHE, platform })
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, '#!/bin/sh\nexit 0\n')
    wanted.set(buildId, exe)
  }
  const found = listManagedBrowsers()
  check(
    `every platform's entry resolves (${platforms.length} platforms)`,
    found.length === platforms.length,
    `found ${found.length}: ${found.map(f => f.buildId).join(', ')} — listManagedBrowsers in src/integrations/browser/browserResolver.ts must find the cache entry of every BrowserPlatform`,
  )
  for (const [buildId, exe] of wanted) {
    const row = found.find(f => f.buildId === buildId)
    check(`${buildId} resolves to the package-derived executable`, row?.executablePath === exe, `${row?.executablePath ?? '(missing)'} — listManagedBrowsers in src/integrations/browser/browserResolver.ts must return the path computeExecutablePath gives for this build`)
  }
  const armExe = computeExecutablePath({
    browser: CftBrowser.CHROME,
    buildId: '153.0.8001.5',
    cacheDir: CACHE,
    platform: BrowserPlatform.LINUX_ARM,
  })
  mkdirSync(join(armExe, '..'), { recursive: true })
  writeFileSync(armExe, '#!/bin/sh\nexit 0\n')
  check('the post-153 linux-arm64 layout is found', armExe.includes('chrome-linux-arm64') && listManagedBrowsers().some(f => f.buildId === '153.0.8001.5'), `${armExe} — listManagedBrowsers in src/integrations/browser/browserResolver.ts must find the chrome-linux-arm64 layout`)
}

console.log('§2 plan persistence across the process boundary')
{
  clearPersistedInstallPlan()
  check('no plan recorded reads as null', readPersistedInstallPlan() === null, 'readPersistedInstallPlan in src/integrations/browser/browserInstall.ts must return null when no plan file exists')
  persistInstallPlan('151.0.7100.0')
  const fresh = readPersistedInstallPlan()
  check('a persisted plan survives (the file IS the cross-process token)', fresh?.buildId === '151.0.7100.0' && fresh.expired === false, `${JSON.stringify(fresh)} — persistInstallPlan and readPersistedInstallPlan in src/integrations/browser/browserInstall.ts must round-trip a fresh plan`)
  writeFileSync(join(CACHE, '.install-plan.json'), JSON.stringify({ buildId: '151.0.7100.0', plannedAt: Date.now() - INSTALL_PLAN_TTL_MS - 1000 }))
  check('an aged plan reads as EXPIRED (distinct from absent)', readPersistedInstallPlan()?.expired === true, 'readPersistedInstallPlan in src/integrations/browser/browserInstall.ts must report expired: true for a plan older than INSTALL_PLAN_TTL_MS')
  clearPersistedInstallPlan()
  check('clear consumes the token', readPersistedInstallPlan() === null, 'clearPersistedInstallPlan in src/integrations/browser/browserInstall.ts must remove the plan file')
}

console.log('§3 pinned plans need no network; bad tokens refuse by name')
{
  const plan = await planBrowserInstall('142.0.7444.99')
  check('a pinned buildId plans WITHOUT the network and names itself', plan.buildId === '142.0.7444.99' && plan.consentLine.includes('142.0.7444.99') && plan.consentLine.includes('pinned'), `${plan.consentLine} — planBrowserInstall in src/integrations/browser/browserInstall.ts must plan a pinned buildId without the network and name it in the consent line`)
  const bogus = await browserCommand('install not-a-build', ctx)
  check('/browser install with an unrecognized token refuses by name', bogus.type === 'text' && bogus.value.includes("'not-a-build'"), `${bogus.type === 'text' ? bogus.value : bogus.type} — the install subcommand in src/commands/browser/browserCommand.ts must refuse an unrecognized token and quote it`)
  const pinned = await browserCommand('install 142.0.7444.99', ctx)
  const persisted = readPersistedInstallPlan()
  check('/browser install <buildId> plans and persists THAT build', pinned.type === 'text' && pinned.value.includes('142.0.7444.99') && persisted?.buildId === '142.0.7444.99', `${JSON.stringify(persisted)} — the install subcommand in src/commands/browser/browserCommand.ts must plan and persist the pinned build`)
  for (const args of ['install 142.0.7444.99 unexpected', 'install 142.0.7444.99 143.0.7000.0', 'install confirm 142.0.7444.99 unexpected']) {
    const refused = await browserCommand(args, ctx)
    check('extra install arguments refuse without replacing the pending plan', refused.type === 'text' && refused.value.includes('unrecognized install argument') && JSON.stringify(readPersistedInstallPlan()) === JSON.stringify(persisted), `${refused.type === 'text' ? refused.value : refused.type} — the install subcommand in src/commands/browser/browserCommand.ts must refuse extra arguments with 'unrecognized install argument' and leave the persisted plan as it was`)
  }
  clearPersistedInstallPlan()
  const repeatedConfirm = await browserCommand('install confirm confirm', ctx)
  check('repeated confirmation is an invalid argument, not permission to install', repeatedConfirm.type === 'text' && repeatedConfirm.value.includes("unrecognized install argument 'confirm'"), 'the install subcommand in src/commands/browser/browserCommand.ts must refuse a repeated confirm as an unrecognized install argument')
  const noPlan = await browserCommand('install confirm', ctx)
  check('confirm with nothing recorded says "no plan recorded", not "expired"', noPlan.type === 'text' && noPlan.value.includes('no install plan recorded'), `${noPlan.type === 'text' ? noPlan.value : noPlan.type} — the install confirm path in src/commands/browser/browserCommand.ts must say 'no install plan recorded' when no plan exists`)
}


if (failures > 0) {
  console.error(`\nbrowser provision: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nbrowser provision: green')
