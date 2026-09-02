#!/usr/bin/env bun

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_BROWSER ??= '1'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(env)) {
    prev.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const { resolveBrowser, detectInstalledBrowsers, listManagedBrowsers, driverNodeGate } = await import(
  '../../src/services/browser/browserResolver.ts'
)

import { Browser as CftBrowser, computeExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers'
function makeCacheFixture(buildId: string): string {
  const cache = mkdtempSync(join(tmpdir(), 'vista-browser-cache-'))
  const platform = detectBrowserPlatform()
  if (!platform) throw new Error('unsupported platform for the cache fixture')
  const exe = computeExecutablePath({ browser: CftBrowser.CHROME, buildId, cacheDir: cache, platform })
  mkdirSync(join(exe, '..'), { recursive: true })
  writeFileSync(exe, '#!/bin/sh\nexit 0\n')
  chmodSync(exe, 0o755)
  return cache
}

{
  const fakeExe = join(mkdtempSync(join(tmpdir(), 'vista-browser-pin-')), 'chrome')
  writeFileSync(fakeExe, '#!/bin/sh\nexit 0\n')
  chmodSync(fakeExe, 0o755)
  const r = withEnv({ MERCURY_BROWSER_PATH: fakeExe }, () => resolveBrowser())
  check('pin rung wins', r.state === 'ok' && r.source === 'operator-pin' && r.executablePath === fakeExe, JSON.stringify(r))
  const broken = withEnv({ MERCURY_BROWSER_PATH: '/no/such/browser' }, () => resolveBrowser())
  check(
    'a broken pin names itself (no silent fallback)',
    broken.state === 'unavailable' && broken.note.includes('MERCURY_BROWSER_PATH'),
    JSON.stringify(broken),
  )
}

{
  const cache = makeCacheFixture('142.0.7444.0')
  const managed = withEnv(
    { MERCURY_BROWSER_PATH: undefined, MERCURY_BROWSER_NO_DISCOVERY: '1', MERCURY_BROWSER_CACHE_DIR: cache },
    () => resolveBrowser(),
  )
  check(
    'managed rung resolves the cached build',
    managed.state === 'ok' && managed.source === 'managed-cache' && managed.buildId === '142.0.7444.0',
    JSON.stringify(managed),
  )
  const empty = withEnv(
    {
      MERCURY_BROWSER_PATH: undefined,
      MERCURY_BROWSER_NO_DISCOVERY: '1',
      MERCURY_BROWSER_CACHE_DIR: mkdtempSync(join(tmpdir(), 'vista-browser-empty-')),
    },
    () => resolveBrowser(),
  )
  check(
    'unavailable names BOTH remedies',
    empty.state === 'unavailable' &&
      empty.remedies.some(r => r.includes('/browser install')) &&
      empty.remedies.some(r => r.toLowerCase().includes('install chrome')),
    JSON.stringify(empty),
  )
}

{
  const cache = makeCacheFixture('142.0.7444.0')
  const r = withEnv({ MERCURY_BROWSER_PATH: undefined, MERCURY_BROWSER_CACHE_DIR: cache }, () => resolveBrowser())
  const installed = detectInstalledBrowsers()
  if (installed.length > 0) {
    check('installed rung beats the managed cache', r.state === 'ok' && r.source === 'installed', JSON.stringify(r))
  } else {
    check('managed rung engages when nothing is installed', r.state === 'ok' && r.source === 'managed-cache')
  }
}

{
  const cache = makeCacheFixture('141.0.7000.1')
  const rows = withEnv({ MERCURY_BROWSER_CACHE_DIR: cache }, () => listManagedBrowsers())
  check('managed inventory lists the build with a size', rows.length === 1 && rows[0]!.buildId === '141.0.7000.1' && rows[0]!.sizeBytes > 0)
}

{
  const { compareBuildIdsDesc } = await import('../../src/services/browser/browserResolver.ts')
  const sorted = ['140.0.7259.2', '140.0.7259.10', '139.0.9999.99'].sort(compareBuildIdsDesc)
  check('newest-first is NUMERIC, not lexicographic', sorted[0] === '140.0.7259.10' && sorted[2] === '139.0.9999.99', sorted.join(','))
}

{
  const gate = driverNodeGate()
  const major = Number(process.versions.node.split('.')[0])
  check('node gate verdict matches the runtime', gate.ok === major > 22 || (major === 22 && gate.ok), `node ${process.versions.node}: ${JSON.stringify(gate)}`)
  const src = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserResolver.ts')).text()
  check('the gate names the floor + the remedy in source', src.includes('22, 12') && src.includes('discovery/status stay live'))
}

{
  const resolver = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserResolver.ts')).text()
  check('discovery/resolution never launches (execFileSync only in the version probe)', resolver.split('execFileSync').length === 3)
  const installSrc = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserInstall.ts')).text()
  check('the download call lives ONLY in the consented install module', installSrc.includes('await install({'))
  const sessionSrc = await Bun.file(join(ROOT, 'src', 'services', 'browser', 'browserSession.ts')).text()
  check('the session module never downloads', !sessionSrc.includes('install('))
  check('the launch path never spawns the version probe', !sessionSrc.includes('browserVersionOf('))
  const toolSrc = await Bun.file(join(ROOT, 'src', 'tools', 'BrowserTool', 'BrowserTool.ts')).text()
  check('the tool never downloads', !toolSrc.includes("from '@puppeteer/browsers'"))
  check('open is the permissioned op (ask names the URL)', toolSrc.includes("behavior: 'ask'") && toolSrc.includes('Browser open'))
}

if (failures > 0) {
  console.error(`\nbrowser resolution: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nbrowser resolution: green')
