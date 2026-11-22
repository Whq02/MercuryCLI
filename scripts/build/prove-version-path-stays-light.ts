#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagRegistryFiles, isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = resolve(ROOT, process.env.MERCURY_BUILD_OUTDIR ?? 'dist')
const BUNDLE = resolve(OUT, 'mercury.mjs')
const FLAG_DOOR = flagRegistryFiles(ROOT)[0]!

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('── the --version path stays light at module start and bundle level ──')

const probeCode = `
  const { relative } = await import('node:path')
  const { featureReached } = await import(${JSON.stringify(join(ROOT, 'src/substrate/featureReached.ts'))})
  const { FLAG_REGISTRY, flagEnv } = await import(${JSON.stringify(join(ROOT, FLAG_DOOR))})
  featureReached('verb', '--version')
  const loadedAfterVersion = Object.keys(require.cache).map(p => relative(${JSON.stringify(ROOT)}, p).replaceAll('\\\\', '/'))
  let unregisteredThrew = false
  try {
    flagEnv('MERCURY_UNREGISTERED_PROBE_XYZ')
  } catch (err) {
    unregisteredThrew = err instanceof Error && err.message.includes('unregistered flag')
  }
  const providerFlag = flagEnv('MERCURY_PROVIDER_MANAGED_BY_HOST')
  const registryIsArray = Array.isArray(FLAG_REGISTRY)
  const registryCount = FLAG_REGISTRY.length
  const registrySorted = FLAG_REGISTRY.every((row, i) => i === 0 || FLAG_REGISTRY[i - 1].env < row.env)
  console.log(JSON.stringify({ loadedAfterVersion, unregisteredThrew, providerFlag: providerFlag ?? null, registryIsArray, registryCount, registrySorted }))
`

const envClean = { ...process.env }
delete envClean.MERCURY_FEATURE_TRACE
delete envClean.MERCURY_FEATURE_TRACE_PROOF
const probe = spawnSync(process.execPath, ['-e', probeCode], {
  cwd: ROOT,
  env: envClean,
  encoding: 'utf8',
  timeout: 30_000,
})
check(
  'running --version trace probe in a fresh process exits 0',
  probe.status === 0,
  `exit ${probe.status}: ${(probe.stderr || probe.stdout).trim().slice(0, 200)} — fix src/substrate/featureReached.ts or ${FLAG_DOOR}`,
)

if (probe.status === 0) {
  const parsed = JSON.parse(probe.stdout.trim()) as {
    loadedAfterVersion: string[]
    unregisteredThrew: boolean
    registryIsArray: boolean
    registryCount: number
    registrySorted: boolean
  }
  const flagRowFilesLoaded = parsed.loadedAfterVersion.filter(
    rel => isFlagRegistryFile(rel) && rel !== FLAG_DOOR,
  )
  check(
    `--version loads at most 1 flag group file instead of all 18 (loaded ${flagRowFilesLoaded.length}: ${flagRowFilesLoaded.join(', ')})`,
    flagRowFilesLoaded.length <= 1,
    `loaded ${flagRowFilesLoaded.length} files (${flagRowFilesLoaded.slice(0, 5).join(', ')}) — keep flag group loading lazy in ${FLAG_DOOR}`,
  )
  check(
    'unregistered flag lookup still throws via flagEnv',
    parsed.unregisteredThrew,
    `keep unregistered flag guard in flagEnv in ${FLAG_DOOR}`,
  )
  check(
    `FLAG_REGISTRY materializes lazily as a sorted array (${parsed.registryCount} rows)`,
    parsed.registryIsArray && parsed.registryCount > 100 && parsed.registrySorted,
    `keep FLAG_REGISTRY proxy materializing sorted rows in ${FLAG_DOOR}`,
  )
}

check('dist/mercury.mjs present', existsSync(BUNDLE), 'build the bundle first with bun run build.ts')
if (existsSync(BUNDLE)) {
  const nodeBin = existsSync(join(OUT, 'vendor/node/bin/node')) ? join(OUT, 'vendor/node/bin/node') : 'node'
  const ver = spawnSync(nodeBin, [BUNDLE, '--version'], {
    env: envClean,
    encoding: 'utf8',
    timeout: 15_000,
  })
  check(
    'built dist/mercury.mjs --version exits 0 and prints Mercury version',
    ver.status === 0 && /^Mercury \d+\.\d+\.\d+/.test(ver.stdout.trim()),
    `rc=${ver.status} out=${ver.stdout.trim().slice(0, 80)} err=${ver.stderr.trim().slice(0, 120)} — fix src/entrypoints/cli.tsx`,
  )

  const scratch = mkdtempSync(join(tmpdir(), 'mercury-version-light-'))
  try {
    const traceFile = join(scratch, 'trace.tsv')
    const traced = spawnSync(nodeBin, [BUNDLE, '--version'], {
      env: { ...envClean, MERCURY_FEATURE_TRACE: traceFile, MERCURY_FEATURE_TRACE_PROOF: 'scripts/build/prove-version-path-stays-light.ts' },
      encoding: 'utf8',
      timeout: 15_000,
    })
    const traceText = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : ''
    check(
      'built dist/mercury.mjs --version still records feature trace when MERCURY_FEATURE_TRACE is set',
      traced.status === 0 && traceText.includes('verb\t--version\tbundle\tscripts/build/prove-version-path-stays-light.ts'),
      `trace=${JSON.stringify(traceText.slice(0, 140))} — fix featureReached in src/substrate/featureReached.ts or ${FLAG_DOOR}`,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  const bundleText = readFileSync(BUNDLE, 'utf8')
  const hasZodNamespaceExport = /\{\$ZodAny:\(\)=>/.test(bundleText) || /\{ar:\(\)=>[A-Za-z0-9_$]+,az:\(\)=>[A-Za-z0-9_$]+,be:\(\)=>/.test(bundleText)
  check(
    'built dist/mercury.mjs does not emit the full Zod namespace or all 64 Zod locales',
    !hasZodNamespaceExport,
    'do not pass the whole zod namespace object in src/runner/wire/methods.ts or other modules; pass only the needed builders',
  )

  const hasDeadChangelogArchive = bundleText.includes('Fixed the Anthropic sign-in showing the previous account')
  check(
    'built dist/mercury.mjs omits dead changelogArchive text when MERCURY_CHANGELOG_PACKED is defined',
    !hasDeadChangelogArchive,
    'keep buildMercuryChangelog in the else branch of typeof MERCURY_CHANGELOG_PACKED === "string" and avoid top-level archive parsing in src/constants/changelog.ts',
  )
}

if (failures === 0) {
  console.log('✅ version-path-stays-light proof passes')
  process.exit(0)
}
console.log(`❌ version-path-stays-light proof FAILED (${failures})`)
process.exit(1)
