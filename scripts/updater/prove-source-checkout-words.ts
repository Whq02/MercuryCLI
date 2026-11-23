#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtures, spawnFixtureReleaseServer } from './journeyFixtures.js'

if (process.env.MERCURY_PROVE_CHILD === '1') {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: process.env.MERCURY_PROVE_VERSION ?? '1.0.11' }
  process.argv[1] = process.env.MERCURY_PROVE_INVOKED!
  const { update } = await import('../../src/commands/verbs/update.ts')
  await update(JSON.parse(process.env.MERCURY_PROVE_OPTIONS ?? '{}'))
  process.exit(0)
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.11' }

let failures = 0
let checks = 0
let hint = ''
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${hint}` : ''}`)
}
const section = (title: string, where: string): void => {
  hint = where
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

const { classifyInstallProvenance, gatherInstallProbeFacts } = await import('../../src/platform/update-channel/installProvenance.ts')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'source-checkout-words-')))
const home = join(SCRATCH, 'home')
const configHome = join(home, '.mercury')
const versionsDir = join(SCRATCH, 'versions')
const fixturesRoot = join(SCRATCH, 'fixtures')
const checkout = join(SCRATCH, 'checkout')
const checkoutDist = join(checkout, 'dist')
const checkoutEntry = join(checkoutDist, 'mercury.mjs')
const checkoutSrcEntry = join(checkout, 'src', 'entrypoints', 'cli.tsx')
const deployed = join(SCRATCH, 'deployed', 'runtime', 'builds', 'b1')
const deployedEntry = join(deployed, 'mercury.mjs')

for (const dir of [home, configHome, versionsDir, fixturesRoot, checkoutDist, join(checkout, 'src', 'entrypoints'), join(checkout, '.git'), deployed]) {
  mkdirSync(dir, { recursive: true })
}
writeFileSync(join(checkout, 'build.ts'), '')
writeFileSync(checkoutEntry, '')
writeFileSync(checkoutSrcEntry, '')
writeFileSync(deployedEntry, '')
writeFileSync(join(deployed, 'runtime-manifest.json'), JSON.stringify({ schema: 1 }))

const V_CURRENT = '1.0.11'
const V_NEWER = '9.9.0'
const currentFixtures = makeFixtures(fixturesRoot, 'current', [{ version: V_CURRENT }])
const newerFixtures = makeFixtures(fixturesRoot, 'newer', [{ version: V_NEWER }])
const emptyFixtures = join(fixturesRoot, 'empty')
mkdirSync(emptyFixtures, { recursive: true })
writeFileSync(join(emptyFixtures, 'releases.json'), '[]')
const serverCurrent = await spawnFixtureReleaseServer({ fixtures: currentFixtures })
const serverNewer = await spawnFixtureReleaseServer({ fixtures: newerFixtures })
const serverEmpty = await spawnFixtureReleaseServer({ fixtures: emptyFixtures })

const SELF = fileURLToPath(import.meta.url)
const runUpdate = (
  invokedPath: string,
  options: Record<string, boolean>,
  serverUrl: string,
  version = V_CURRENT,
): { code: number; stdout: string; stderr: string } => {
  const res = spawnSync(process.execPath, [SELF], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_VERSIONS_DIR: versionsDir,
      MERCURY_UPDATE_API_BASE_URL: serverUrl,
      MERCURY_GH_CMD: JSON.stringify([process.execPath, '-e', 'process.exit(1)']),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_PROVE_CHILD: '1',
      MERCURY_PROVE_INVOKED: invokedPath,
      MERCURY_PROVE_OPTIONS: JSON.stringify(options),
      MERCURY_PROVE_VERSION: version,
      CI: '1',
      TERM: 'dumb',
    },
  })
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

section(
  '§1 update --status from a source checkout names the checkout root where build.ts lives, not dist',
  'change gatherInstallProbeFacts and classifyInstallProvenance in src/platform/update-channel/installProvenance.ts',
)
{
  const fromDist = classifyInstallProvenance(gatherInstallProbeFacts({ invokedPath: checkoutEntry, versionsDir }))
  check(
    'source checkout provenance activeRoot points to the checkout root containing build.ts, not dist',
    fromDist.kind === 'development' && fromDist.activeRoot === checkout && existsSync(join(fromDist.activeRoot, 'build.ts')),
    JSON.stringify({ kind: fromDist.kind, activeRoot: fromDist.activeRoot, expected: checkout }),
  )

  const fromSrc = classifyInstallProvenance(gatherInstallProbeFacts({ invokedPath: checkoutSrcEntry, versionsDir }))
  check(
    'running from src/boot/entrypoints/cli.tsx also resolves activeRoot to the checkout root',
    fromSrc.kind === 'development' && fromSrc.activeRoot === checkout,
    JSON.stringify({ kind: fromSrc.kind, activeRoot: fromSrc.activeRoot, expected: checkout }),
  )

  const fromDeployed = classifyInstallProvenance(gatherInstallProbeFacts({ invokedPath: deployedEntry, versionsDir }))
  check(
    'a deployed source build (runtime-manifest.json, no checkout markers) keeps its build dir as activeRoot',
    fromDeployed.kind === 'development' && fromDeployed.activeRoot === deployed,
    JSON.stringify({ kind: fromDeployed.kind, activeRoot: fromDeployed.activeRoot, expected: deployed }),
  )

  const status = runUpdate(checkoutEntry, { status: true }, serverCurrent.url)
  const expectedLine = `this Mercury:      a source checkout at ${checkout} — rebuild it with \`git pull && bun run build.ts\``
  check(
    'update --status names the checkout root beside the rebuild command, never <root>/dist',
    status.code === 0 && status.stdout.includes(expectedLine) && !status.stdout.includes(`at ${checkoutDist}`),
    status.stdout.slice(0, 400),
  )
}

section(
  '§2 update --check adds the "this Mercury:" line whenever the running Mercury is not the managed install',
  'change the options.check branch in src/commands/verbs/update.ts so thisMercury is shown whenever provenance.kind !== "managed"',
)
{
  const managedDir = join(versionsDir, V_CURRENT)
  mkdirSync(managedDir, { recursive: true })
  const managedEntry = join(managedDir, 'mercury.mjs')
  writeFileSync(managedEntry, '')
  writeFileSync(join(managedDir, 'manifest.json'), JSON.stringify({ version: V_CURRENT }))
  writeFileSync(join(versionsDir, 'current.txt'), `${V_CURRENT}\n`)

  const checkoutLine = `\n  this Mercury: a source checkout at ${checkout} — rebuild it with \`git pull && bun run build.ts\``

  const checkCurrent = runUpdate(checkoutEntry, { check: true }, serverCurrent.url)
  check(
    'source checkout with co-resident managed install: --check (current) names the managed version and adds "this Mercury:"',
    checkCurrent.code === 0 && checkCurrent.stdout.startsWith(`Mercury is current: ${V_CURRENT}`) && checkCurrent.stdout.includes(checkoutLine),
    checkCurrent.stdout.slice(0, 400),
  )

  const checkJson = runUpdate(checkoutEntry, { check: true, json: true }, serverCurrent.url)
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(checkJson.stdout) as Record<string, unknown>
  } catch {
    parsed = null
  }
  const prov = parsed?.provenance as Record<string, unknown> | undefined
  check(
    '--check --json keeps its fields with activeRoot naming the checkout root',
    checkJson.code === 0 &&
      parsed?.mode === 'check' &&
      parsed?.state === 'current' &&
      parsed?.installed === V_CURRENT &&
      typeof parsed?.channelRepo === 'string' &&
      typeof parsed?.road === 'string' &&
      prov?.kind === 'development' &&
      prov?.activeRoot === checkout &&
      prov?.updateOwner === 'source-build' &&
      prov?.updateCommand === null &&
      prov?.npmWrapper === null,
    checkJson.stdout.slice(0, 400),
  )

  const checkNewer = runUpdate(checkoutEntry, { check: true }, serverNewer.url)
  check(
    'source checkout with co-resident managed install: --check (update-available) adds "this Mercury:" and keeps the channel road',
    checkNewer.code === 0 &&
      checkNewer.stdout.includes(`update available: v${V_NEWER} (installed: ${V_CURRENT})`) &&
      checkNewer.stdout.includes(checkoutLine) &&
      checkNewer.stdout.trim().endsWith('run `mercury update` to install it'),
    checkNewer.stdout.slice(0, 400),
  )

  const checkEmpty = runUpdate(checkoutEntry, { check: true }, serverEmpty.url)
  check(
    'source checkout with co-resident managed install: --check (no-releases) adds "this Mercury:"',
    checkEmpty.code === 0 && checkEmpty.stdout.includes('no releases found') && checkEmpty.stdout.includes(checkoutLine),
    checkEmpty.stdout.slice(0, 400),
  )

  const managedCurrent = runUpdate(managedEntry, { check: true }, serverCurrent.url)
  check(
    'control: the managed install itself does not add a "this Mercury:" line on --check',
    managedCurrent.code === 0 && managedCurrent.stdout.startsWith(`Mercury is current: ${V_CURRENT}`) && !managedCurrent.stdout.includes('this Mercury:'),
    managedCurrent.stdout.slice(0, 400),
  )
}

await serverCurrent.close()
await serverNewer.close()
await serverEmpty.close()
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nprove-source-checkout-words: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
