#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = resolve(ROOT, process.env.MERCURY_BUILD_OUTDIR ?? 'dist')
const BUNDLE = resolve(OUT, 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('── the --version path and bundle stay free of Zod locales and dead changelogArchive ──')

const envClean = { ...process.env }
delete envClean.MERCURY_FEATURE_TRACE
delete envClean.MERCURY_FEATURE_TRACE_PROOF

const probeCode = `
  const { relative } = await import('node:path')
  globalThis.MACRO = { VERSION: '1.0.0' }
  process.argv = [process.execPath, ${JSON.stringify(join(ROOT, 'src/boot/entrypoints/cli.tsx'))}, '--version']
  await import(${JSON.stringify(join(ROOT, 'src/boot/entrypoints/cli.tsx'))})
  const loaded = Object.keys(require.cache).map(p => relative(${JSON.stringify(ROOT)}, p).replaceAll('\\\\', '/'))
  console.log('__PROBE__' + JSON.stringify({ loaded }))
`
const probe = spawnSync(process.execPath, ['-e', probeCode], {
  cwd: ROOT,
  env: envClean,
  encoding: 'utf8',
  timeout: 30_000,
})
const probeLine = probe.stdout.split('\n').find(l => l.startsWith('__PROBE__'))
check(
  'running --version from source in a fresh process exits 0',
  probe.status === 0 && probeLine !== undefined,
  `exit ${probe.status}: ${(probe.stderr || probe.stdout).trim().slice(0, 200)} — fix src/boot/entrypoints/cli.tsx`,
)
if (probeLine !== undefined) {
  const parsed = JSON.parse(probeLine.slice('__PROBE__'.length)) as { loaded: string[] }
  const loadedArchive = parsed.loaded.some(rel => rel === 'src/commands/update-notes/changelogArchive.ts' || rel === 'src/commands/update-notes/changelog.ts')
  check(
    '--version does not load or parse changelogArchive',
    !loadedArchive,
    'keep changelog and changelogArchive off the --version path in src/boot/entrypoints/cli.tsx and src/commands/update-notes/changelog.ts',
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
    `rc=${ver.status} out=${ver.stdout.trim().slice(0, 80)} err=${ver.stderr.trim().slice(0, 120)} — fix src/boot/entrypoints/cli.tsx`,
  )

  const scratch = mkdtempSync(join(tmpdir(), 'mercury-version-light-'))
  try {
    const traceFile = join(scratch, 'trace.tsv')
    const traced = spawnSync(nodeBin, [BUNDLE, '--version'], {
      env: { ...process.env, MERCURY_FEATURE_TRACE: traceFile, MERCURY_FEATURE_TRACE_PROOF: 'scripts/build/prove-version-path-stays-light.ts' },
      encoding: 'utf8',
      timeout: 15_000,
    })
    const traceText = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : ''
    check(
      'built dist/mercury.mjs --version still records feature trace when MERCURY_FEATURE_TRACE is set',
      traced.status === 0 && traceText.includes('verb\t--version\tbundle\tscripts/build/prove-version-path-stays-light.ts'),
      `trace=${JSON.stringify(traceText.slice(0, 140))} — fix featureReached in src/platform/substrate/featureReached.ts`,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  const bundleText = readFileSync(BUNDLE, 'utf8')
  const hasZodNamespaceExport = /\{\$ZodAny:\(\)=>/.test(bundleText) || /\{ar:\(\)=>[A-Za-z0-9_$]+,az:\(\)=>[A-Za-z0-9_$]+,be:\(\)=>/.test(bundleText)
  check(
    'built dist/mercury.mjs does not emit the full Zod namespace or all 64 Zod locales',
    !hasZodNamespaceExport,
    'do not pass the whole zod namespace object in src/daemon/runner-wire/methods.ts or other modules; pass only the needed builders',
  )

  const hasDeadChangelogArchive = bundleText.includes('Fixed the Anthropic sign-in showing the previous account')
  check(
    'built dist/mercury.mjs omits dead changelogArchive text when MERCURY_CHANGELOG_PACKED is defined',
    !hasDeadChangelogArchive,
    'keep buildMercuryChangelog in the else branch of typeof MERCURY_CHANGELOG_PACKED === "string" and avoid top-level archive parsing in src/commands/update-notes/changelog.ts',
  )
}

if (failures === 0) {
  console.log('✅ version-path-stays-light proof passes')
  process.exit(0)
}
console.log(`❌ version-path-stays-light proof FAILED (${failures})`)
process.exit(1)
