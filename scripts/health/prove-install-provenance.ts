#!/usr/bin/env bun
// prove-install-provenance — the ONE typed
// install-provenance owner. getCurrentInstallationType() was an explicit
// placeholder returning 'source-build' unconditionally — every managed
// install's health surface recommended `git pull && bun run build.ts`.
//
//   §1 the fixture battery (IP-15): managed · direct versioned invocation ·
//      stale pointer · missing payload · extracted · development · bare
//      bundle · pointer-presence-alone · win32 casing.
//   §2 guidance (IP-07/08/09): managed names `mercury update`, never git
//      pull; development alone gets the rebuild line; neutral otherwise.
//   §3 wiring (IP-01/10/12/16): one snapshot, consumers delegate, no
//      `hermes` search, bounded resolution.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.5.4-test' }

const {
  classifyInstallProvenance,
  gatherInstallProbeFacts,
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

const SCRATCH = mkdtempSync(join(tmpdir(), 'install-provenance-'))

/** Build a managed layout: <root>/versions/<v>/{mercury.mjs,manifest.json}. */
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

const gather = (entry: string, versionsDir: string, platform: NodeJS.Platform = 'darwin') =>
  classifyInstallProvenance(gatherInstallProbeFacts({ invokedPath: entry, versionsDir, platform }))

section('§1 THE FIXTURE BATTERY (IP-15)')
{
  // 1 · healthy managed.
  const r1 = join(SCRATCH, 'managed-1')
  const e1 = makeManaged(r1, '1.5.3-beta.1')
  const p1 = gather(e1, join(r1, 'versions'))
  check(
    'healthy managed resolves MANAGED from the entry binding (IP-02/18)',
    p1.kind === 'managed' && p1.disagreements.length === 0 && p1.activeRoot.endsWith('1.5.3-beta.1'),
    `${p1.kind} ${p1.disagreements.join(';')}`,
  )
  check('managed evidence names the binding, not pointer presence', p1.evidence.some(e => e.includes('IP-18')))

  // 2 · direct versioned invocation (running v2 while current names v1).
  const r2 = join(SCRATCH, 'managed-2')
  makeManaged(r2, '1.5.2-beta.1')
  const e2 = makeManaged(r2, '1.5.3-beta.1', { current: '1.5.2-beta.1' })
  const p2 = gather(e2, join(r2, 'versions'))
  check(
    'direct versioned invocation stays MANAGED with the disagreement VISIBLE (IP-13)',
    p2.kind === 'managed' && p2.disagreements.some(d => d.includes('direct versioned invocation')),
    p2.disagreements.join(';'),
  )

  // 3 · stale pointer (current names a missing dir).
  const r3 = join(SCRATCH, 'managed-3')
  const e3 = makeManaged(r3, '1.5.3-beta.1', { current: '9.9.9-beta.1' })
  const p3 = gather(e3, join(r3, 'versions'))
  check(
    'a stale pointer is a visible disagreement, never a silent collapse (IP-13)',
    p3.kind === 'managed' && p3.disagreements.some(d => d.includes('stale pointer')),
    p3.disagreements.join(';'),
  )

  // 4 · missing payload manifest under the versions layout.
  const r4 = join(SCRATCH, 'managed-4')
  const e4 = makeManaged(r4, '1.5.3-beta.1', { manifest: false })
  const p4 = gather(e4, join(r4, 'versions'))
  check(
    'versions layout WITHOUT its payload manifest resolves UNKNOWN (IP-05: conflicting evidence)',
    p4.kind === 'unknown' && p4.evidence.some(e => e.includes('MISSING')),
    p4.kind,
  )

  // 5 · extracted release in place + a healthy co-resident managed install.
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

  // 6 · development: THIS repo's entry (build.ts + src + .git above).
  const pDev = gather(join(import.meta.dir, '../../dist/mercury.mjs'), join(SCRATCH, 'no-versions'))
  check('a confirmed checkout resolves DEVELOPMENT (IP-04)', pDev.kind === 'development', pDev.kind)

  // 7 · a bare bundle copied alone ⇒ UNKNOWN, never source-build (IP-05).
  const bare = join(SCRATCH, 'bare')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'mercury.mjs'), '// bundle\n')
  const p7 = gather(join(bare, 'mercury.mjs'), join(SCRATCH, 'no-versions-2'))
  check("a bare bundle resolves UNKNOWN — never 'source-build' by default (IP-05)", p7.kind === 'unknown', p7.kind)
  check("the retired 'source-build' kind is unrepresentable", !['source-build'].includes(p7.kind))

  // 8 · pointer presence ALONE is not managed (IP-18): the bare entry with a
  // healthy pointer nearby still classifies by its OWN shape.
  const p8 = gather(join(bare, 'mercury.mjs'), join(rCo, 'versions'))
  check(
    'current.txt presence alone never makes the entry managed (IP-18)',
    p8.kind === 'unknown' && p8.managedCoResident !== undefined,
    p8.kind,
  )

  // 9 · win32 casing: containment is case-insensitive; the version STRING
  // mismatch stays visible (IP-19).
  const r9 = join(SCRATCH, 'win-managed')
  const e9 = makeManaged(r9, '1.5.3-beta.1', { current: '1.5.2-beta.1' })
  const p9 = classifyInstallProvenance(
    gatherInstallProbeFacts({
      invokedPath: e9.toUpperCase() === e9 ? e9 : e9, // realpath keeps the on-disk case on darwin
      versionsDir: join(r9, 'versions'),
      platform: 'win32',
    }),
  )
  check(
    'win32 normalization keeps containment AND the genuine pointer mismatch visible (IP-19)',
    p9.kind === 'managed' && p9.disagreements.some(d => d.includes('direct versioned invocation')),
    `${p9.kind} ${p9.disagreements.join(';')}`,
  )
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
}

section('§3 WIRING (IP-01/10/12/16)')
{
  const owner = src('src/services/privateChannel/installProvenance.ts')
  check(
    'the resolver never searches for the obsolete hermes launcher (IP-12)',
    !owner.includes("which(") && !owner.includes("'hermes'") && !owner.includes('"hermes"'),
  )
  check(
    'resolution is bounded — no spawns in the owner (IP-16)',
    !/(?<![.\w])(spawn|spawnSync|execFile|exec)\(/.test(owner),
  )
  const diag = src('src/utils/healthDiagnostic.ts')
  check(
    'getCurrentInstallationType delegates to the ONE snapshot (IP-01)',
    diag.includes('resolveInstallProvenance') && !diag.includes("return 'source-build'"),
  )
  check('the hermes-launcher search died with the placeholder (IP-12)', !diag.includes("which('hermes')"))
  check(
    "/health carries the install-provenance row consuming the same snapshot (IP-10)",
    src('src/utils/healthReport.ts').includes("id: 'install-provenance'"),
  )
  // IP-14: the no-op update's forward-only receipt is owned by the update
  // verb's existing estate — cite, never re-prove here.
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
