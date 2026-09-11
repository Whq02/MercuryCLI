#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.5.4-test' }

const {
  classifyInstallProvenance,
  foreignInstallerOf,
  gatherInstallProbeFacts,
  homebrewKegOf,
  npmPackageDirOf,
  provenanceGuidance,
  provenanceLine,
} = await import('../../src/services/privateChannel/installProvenance.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'install-provenance-')))

function makeManaged(root: string, version: string, opts?: { manifest?: boolean; current?: string | null }): string {
  const vdir = join(root, 'versions', version)
  mkdirSync(vdir, { recursive: true })
  writeFileSync(join(vdir, 'mercury.mjs'), '// bundle\n')
  if (opts?.manifest !== false) writeFileSync(join(vdir, 'manifest.json'), '{"node":">=24"}\n')
  if (opts?.current !== null) {
    writeFileSync(join(root, 'versions', 'current.txt'), (opts?.current ?? version) + '\n')
  }
  return join(vdir, 'mercury.mjs')
}

const gather = (entry: string, versionsDir: string, platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}) =>
  classifyInstallProvenance(gatherInstallProbeFacts({ invokedPath: entry, versionsDir, platform, env }))

section('§1 THE FIXTURE BATTERY (IP-15)')
{
  const r1 = join(SCRATCH, 'managed-1')
  const e1 = makeManaged(r1, '1.5.3-beta.1')
  const p1 = gather(e1, join(r1, 'versions'))
  check(
    'healthy managed resolves MANAGED from the entry binding (IP-02/18)',
    p1.kind === 'managed' && p1.disagreements.length === 0 && p1.activeRoot.endsWith('1.5.3-beta.1'),
    `${p1.kind} ${p1.disagreements.join(';')}`,
  )
  check('managed evidence names the binding, not pointer presence', p1.evidence.some(e => e.includes('IP-18')))

  const r2 = join(SCRATCH, 'managed-2')
  makeManaged(r2, '1.5.2-beta.1')
  const e2 = makeManaged(r2, '1.5.3-beta.1', { current: '1.5.2-beta.1' })
  const p2 = gather(e2, join(r2, 'versions'))
  check(
    'direct versioned invocation stays MANAGED with the disagreement VISIBLE (IP-13)',
    p2.kind === 'managed' && p2.disagreements.some(d => d.includes('direct versioned invocation')),
    p2.disagreements.join(';'),
  )

  const r3 = join(SCRATCH, 'managed-3')
  const e3 = makeManaged(r3, '1.5.3-beta.1', { current: '9.9.9-beta.1' })
  const p3 = gather(e3, join(r3, 'versions'))
  check(
    'a stale pointer is a visible disagreement, never a silent collapse (IP-13)',
    p3.kind === 'managed' && p3.disagreements.some(d => d.includes('stale pointer')),
    p3.disagreements.join(';'),
  )

  const r4 = join(SCRATCH, 'managed-4')
  const e4 = makeManaged(r4, '1.5.3-beta.1', { manifest: false })
  const p4 = gather(e4, join(r4, 'versions'))
  check(
    'versions layout WITHOUT its payload manifest resolves UNKNOWN (IP-05: conflicting evidence)',
    p4.kind === 'unknown' && p4.evidence.some(e => e.includes('MISSING')),
    p4.kind,
  )

  const rCo = join(SCRATCH, 'co-managed')
  makeManaged(rCo, '1.5.3-beta.1')
  const ex = join(SCRATCH, 'extracted')
  mkdirSync(ex, { recursive: true })
  writeFileSync(join(ex, 'mercury.mjs'), '// bundle\n')
  writeFileSync(join(ex, 'manifest.json'), '{}\n')
  writeFileSync(join(ex, 'mercury.cmd'), '@echo off\n')
  const p5 = gather(join(ex, 'mercury.mjs'), join(rCo, 'versions'))
  check('a complete extracted payload run in place resolves EXTRACTED-RELEASE (IP-03)', p5.kind === 'extracted-release', p5.kind)
  check(
    'the co-resident managed install is reported SEPARATELY, never conflated (IP-17)',
    p5.managedCoResident?.current === '1.5.3-beta.1',
    JSON.stringify(p5.managedCoResident),
  )

  const pDev = gather(join(import.meta.dir, '../../dist/mercury.mjs'), join(SCRATCH, 'no-versions'))
  check('a confirmed checkout resolves DEVELOPMENT (IP-04)', pDev.kind === 'development', pDev.kind)

  const bare = join(SCRATCH, 'bare')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'mercury.mjs'), '// bundle\n')
  const p7 = gather(join(bare, 'mercury.mjs'), join(SCRATCH, 'no-versions-2'))
  check("a bare bundle resolves UNKNOWN — never 'source-build' by default (IP-05)", p7.kind === 'unknown', p7.kind)
  check("the retired 'source-build' kind is unrepresentable", !['source-build'].includes(p7.kind))

  const p8 = gather(join(bare, 'mercury.mjs'), join(rCo, 'versions'))
  check(
    'current.txt presence alone never makes the entry managed (IP-18)',
    p8.kind === 'unknown' && p8.managedCoResident !== undefined,
    p8.kind,
  )

  const r9 = join(SCRATCH, 'win-managed')
  const e9 = makeManaged(r9, '1.5.3-beta.1', { current: '1.5.2-beta.1' })
  const p9 = classifyInstallProvenance(
    gatherInstallProbeFacts({
      invokedPath: e9.toUpperCase() === e9 ? e9 : e9,
      versionsDir: join(r9, 'versions'),
      platform: 'win32',
    }),
  )
  check(
    'win32 normalization keeps containment AND the genuine pointer mismatch visible (IP-19)',
    p9.kind === 'managed' && p9.disagreements.some(d => d.includes('direct versioned invocation')),
    `${p9.kind} ${p9.disagreements.join(';')}`,
  )

  const keg = join(SCRATCH, 'brew', 'Cellar', 'mercury', '1.0.0-beta.4')
  mkdirSync(join(keg, 'libexec'), { recursive: true })
  writeFileSync(join(keg, 'libexec', 'mercury.mjs'), '// bundle\n')
  writeFileSync(join(keg, 'libexec', 'manifest.json'), '{}\n')
  writeFileSync(join(keg, 'libexec', 'mercury'), '#!/bin/sh\n')
  const p10 = gather(join(keg, 'libexec', 'mercury.mjs'), join(rCo, 'versions'))
  check(
    'a bundle under Cellar/mercury/<version>/ resolves HOMEBREW, ahead of the extracted-release shape it also has',
    p10.kind === 'homebrew' && p10.updateOwner === 'homebrew' && p10.activeRoot === join(keg, 'libexec'),
    `${p10.kind} ${p10.activeRoot}`,
  )
  check(
    'the Homebrew evidence names the keg, and the co-resident managed install stays reported separately (IP-17)',
    p10.evidence.some(e => e.includes(keg)) && p10.managedCoResident?.current === '1.5.3-beta.1',
    `${p10.evidence.join(';')} ${JSON.stringify(p10.managedCoResident)}`,
  )
  check('the keg detector answers the keg directory itself', homebrewKegOf(join(keg, 'libexec', 'mercury.mjs'), {}) === keg)
  check('a path that only mentions the words is no keg', homebrewKegOf('/x/Cellar/mercury', {}) === null && homebrewKegOf('/x/Cellar/other/1.0/libexec/mercury.mjs', {}) === null)

  const cellar = join(SCRATCH, 'brew-custom', 'kegs')
  mkdirSync(join(cellar, 'mercury', '1.0.0-beta.4', 'libexec'), { recursive: true })
  writeFileSync(join(cellar, 'mercury', '1.0.0-beta.4', 'libexec', 'mercury.mjs'), '// bundle\n')
  const customEntry = join(cellar, 'mercury', '1.0.0-beta.4', 'libexec', 'mercury.mjs')
  const p11 = gather(customEntry, join(SCRATCH, 'no-versions-5'), 'darwin', { HOMEBREW_CELLAR: cellar })
  check('HOMEBREW_CELLAR names a cellar of another name', p11.kind === 'homebrew', p11.kind)
  const p11b = gather(customEntry, join(SCRATCH, 'no-versions-5'), 'darwin', {})
  check('without the variable the same path is not Homebrew', p11b.kind === 'unknown', p11b.kind)
  const prefixed = join(SCRATCH, 'brew-prefix')
  mkdirSync(join(prefixed, 'Cellar', 'mercury', '1.0.0-beta.4', 'libexec'), { recursive: true })
  const prefixedEntry = join(prefixed, 'Cellar', 'mercury', '1.0.0-beta.4', 'libexec', 'mercury.mjs')
  writeFileSync(prefixedEntry, '// bundle\n')
  check('HOMEBREW_PREFIX names the prefix whose Cellar holds the keg', homebrewKegOf(prefixedEntry, { HOMEBREW_PREFIX: prefixed }) === join(prefixed, 'Cellar', 'mercury', '1.0.0-beta.4'))

  const pkg = join(SCRATCH, 'npm', 'lib', 'node_modules', 'mercury-tech-cli')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'dist', 'mercury.mjs'), '// bundle\n')
  const p12 = gather(join(pkg, 'dist', 'mercury.mjs'), join(SCRATCH, 'no-versions-6'))
  check('a bundle under node_modules/mercury-tech-cli/ resolves NPM', p12.kind === 'npm' && p12.updateOwner === 'npm', p12.kind)
  check('the package detector answers the package directory', npmPackageDirOf(join(pkg, 'dist', 'mercury.mjs')) === pkg && npmPackageDirOf('/x/node_modules/other/mercury.mjs') === null)

  const r13 = join(SCRATCH, 'Cellar', 'mercury', 'x')
  const e13 = makeManaged(r13, '1.5.3-beta.1')
  const p13 = gather(e13, join(r13, 'versions'))
  check('an entry bound to the versions layout stays MANAGED whatever the path above it spells', p13.kind === 'managed', p13.kind)
}

section('§2 GUIDANCE (IP-07/08/09)')
{
  const managed = gather(makeManaged(join(SCRATCH, 'g1'), '1.5.3-beta.1'), join(SCRATCH, 'g1', 'versions'))
  check(
    'managed guidance names mercury update / check / rollback — NEVER git pull (IP-07)',
    provenanceGuidance(managed).includes('mercury update') && !provenanceGuidance(managed).includes('git pull'),
  )
  const dev = gather(join(import.meta.dir, '../../dist/mercury.mjs'), join(SCRATCH, 'no-versions-3'))
  check('development ALONE gets the rebuild line (IP-08)', provenanceGuidance(dev).includes('git pull && bun run build.ts'))
  const bare2 = join(SCRATCH, 'bare2')
  mkdirSync(bare2, { recursive: true })
  writeFileSync(join(bare2, 'mercury.mjs'), '//\n')
  const unknown = gather(join(bare2, 'mercury.mjs'), join(SCRATCH, 'no-versions-4'))
  check(
    'unknown gets neutral adopt-managed guidance (IP-09)',
    provenanceGuidance(unknown).includes('mercury install') && !provenanceGuidance(unknown).includes('git pull'),
  )
  check('the display line carries kind + version + root', provenanceLine(managed).includes('managed') && provenanceLine(managed).includes('1.5.4-test'))
  const keg = join(SCRATCH, 'g-brew', 'Cellar', 'mercury', '1.0.0-beta.4', 'libexec')
  mkdirSync(keg, { recursive: true })
  writeFileSync(join(keg, 'mercury.mjs'), '//\n')
  const brew = gather(join(keg, 'mercury.mjs'), join(SCRATCH, 'no-versions-7'))
  const brewWords = provenanceGuidance(brew)
  check(
    'Homebrew guidance names brew upgrade and what `mercury update` manages',
    brewWords.includes('update it with `brew upgrade Whq02/mercury/mercury`') && brewWords.includes('`mercury update` manages installs made by `mercury install` or the install script') && !brewWords.includes('git pull'),
    brewWords,
  )
  const pkg = join(SCRATCH, 'g-npm', 'node_modules', 'mercury-tech-cli')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'mercury.mjs'), '//\n')
  const npm = gather(join(pkg, 'mercury.mjs'), join(SCRATCH, 'no-versions-8'))
  const npmWords = provenanceGuidance(npm)
  check('npm guidance names npm update and what `mercury update` manages', npmWords.includes('update it with `npm update -g mercury-tech-cli`') && npmWords.includes('`mercury update` manages installs made by'), npmWords)
  check(
    'the foreign-installer view names Homebrew and npm with their commands, and nothing for the shapes `mercury update` manages',
    foreignInstallerOf(brew)?.name === 'Homebrew' && foreignInstallerOf(brew)?.updateCommand === 'brew upgrade Whq02/mercury/mercury' && foreignInstallerOf(npm)?.name === 'npm' && foreignInstallerOf(npm)?.updateCommand === 'npm update -g mercury-tech-cli' && foreignInstallerOf(managed) === null && foreignInstallerOf(dev) === null && foreignInstallerOf(unknown) === null,
  )
  check('the display line for a Homebrew install says homebrew and where it runs from', provenanceLine(brew).startsWith('homebrew 1.5.4-test') && provenanceLine(brew).includes(keg))
}

section('§3 WIRING (IP-01/10/12/16)')
{
  const owner = src('src/services/privateChannel/installProvenance.ts')
  check('the resolver runs no PATH search (IP-12)', !owner.includes("which("))
  check(
    'resolution is bounded — no spawns in the owner (IP-16)',
    !/(?<![.\w])(spawn|spawnSync|execFile|exec)\(/.test(owner),
  )
  const diag = src('src/utils/healthDiagnostic.ts')
  check(
    'getCurrentInstallationType delegates to the ONE snapshot (IP-01)',
    diag.includes('resolveInstallProvenance') && !diag.includes("return 'source-build'"),
  )
  check(
    "/health carries the install-provenance row consuming the same snapshot (IP-10)",
    src('src/utils/healthReport.ts').includes("id: 'install-provenance'"),
  )
  check(
    'IP-14 rides the update verb estate (structural cite)',
    src('src/cli/update.ts').includes('performUpdate'),
  )
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-install-provenance: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-install-provenance: all green')
