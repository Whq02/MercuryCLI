#!/usr/bin/env bun

import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Browser as CftBrowser, BrowserPlatform, computeExecutablePath } from '@puppeteer/browsers'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const CACHE = mkdtempSync(join(tmpdir(), 'mercury-provision-'))
process.env.MERCURY_BROWSER_CACHE_DIR = CACHE
process.env.MERCURY_BROWSER ??= '1'

const { listManagedBrowsers } = await import('../../src/services/browser/browserResolver.ts')
const {
  INSTALL_PLAN_TTL_MS,
  clearPersistedInstallPlan,
  persistInstallPlan,
  planBrowserInstall,
  readPersistedInstallPlan,
} = await import('../../src/services/browser/browserInstall.ts')
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
    `found ${found.length}: ${found.map(f => f.buildId).join(', ')}`,
  )
  for (const [buildId, exe] of wanted) {
    const row = found.find(f => f.buildId === buildId)
    check(`${buildId} resolves to the package-derived executable`, row?.executablePath === exe, row?.executablePath ?? '(missing)')
  }
  const armExe = computeExecutablePath({
    browser: CftBrowser.CHROME,
    buildId: '153.0.8001.5',
    cacheDir: CACHE,
    platform: BrowserPlatform.LINUX_ARM,
  })
  mkdirSync(join(armExe, '..'), { recursive: true })
  writeFileSync(armExe, '#!/bin/sh\nexit 0\n')
  check('the post-153 linux-arm64 layout is found', armExe.includes('chrome-linux-arm64') && listManagedBrowsers().some(f => f.buildId === '153.0.8001.5'), armExe)
}

console.log('§2 plan persistence across the process boundary')
{
  clearPersistedInstallPlan()
  check('no plan recorded reads as null', readPersistedInstallPlan() === null)
  persistInstallPlan('151.0.7100.0')
  const fresh = readPersistedInstallPlan()
  check('a persisted plan survives (the file IS the cross-process token)', fresh?.buildId === '151.0.7100.0' && fresh.expired === false, JSON.stringify(fresh))
  writeFileSync(join(CACHE, '.install-plan.json'), JSON.stringify({ buildId: '151.0.7100.0', plannedAt: Date.now() - INSTALL_PLAN_TTL_MS - 1000 }))
  check('an aged plan reads as EXPIRED (distinct from absent)', readPersistedInstallPlan()?.expired === true)
  clearPersistedInstallPlan()
  check('clear consumes the token', readPersistedInstallPlan() === null)
}

console.log('§3 pinned plans need no network; bad tokens refuse by name')
{
  const plan = await planBrowserInstall('142.0.7444.99')
  check('a pinned buildId plans WITHOUT the network and names itself', plan.buildId === '142.0.7444.99' && plan.consentLine.includes('142.0.7444.99') && plan.consentLine.includes('pinned'), plan.consentLine)
  const bogus = await browserCommand('install not-a-build', ctx)
  check('/browser install with an unrecognized token refuses by name', bogus.type === 'text' && bogus.value.includes("'not-a-build'"), bogus.type === 'text' ? bogus.value : bogus.type)
  const pinned = await browserCommand('install 142.0.7444.99', ctx)
  const persisted = readPersistedInstallPlan()
  check('/browser install <buildId> plans and persists THAT build', pinned.type === 'text' && pinned.value.includes('142.0.7444.99') && persisted?.buildId === '142.0.7444.99', JSON.stringify(persisted))
  clearPersistedInstallPlan()
  const noPlan = await browserCommand('install confirm', ctx)
  check('confirm with nothing recorded says "no plan recorded", not "expired"', noPlan.type === 'text' && noPlan.value.includes('no install plan recorded'), noPlan.type === 'text' ? noPlan.value : noPlan.type)
}

console.log('§4 structural honesty')
{
  const sessionSrc = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserSession.ts')).text()
  check('the launch DENIES page-initiated downloads (the header law is a mechanism now)', sessionSrc.includes("downloadBehavior: { policy: 'deny' }"))
  const installSrc = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserInstall.ts')).text()
  check('the metadata fetch is deadline-bounded', installSrc.includes('withDeadline(') && installSrc.includes('12_000'))
  const resolverSrc = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserResolver.ts')).text()
  check('the unavailable remedies name op:"provision" (an agent-walkable road)', resolverSrc.includes('op:"provision"'))
  check("the remedy list carries no dangling ', or' tail", !resolverSrc.includes("normally, or'"))
  const toolSrc = await Bun.file(join(ROOT, 'src', 'tools', 'BrowserTool', 'BrowserTool.ts')).text()
  check('the tool renders the no-hand-rolling sentence at the unavailable door', toolSrc.includes('do NOT hand-build a browser harness'))
  check('provision has its OWN gate (never origin-scoped, never in ACT_OPS)', toolSrc.includes("input.op === 'provision'") && !toolSrc.replace(/\s+/g, ' ').includes("'hover', 'provision'"))
}

if (failures > 0) {
  console.error(`\nbrowser provision: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nbrowser provision: green')
