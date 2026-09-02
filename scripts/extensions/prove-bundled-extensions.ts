#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-bundled-extensions.ts — bundled = pre-installed,
//  same manifest. From the BUILT artifact.
//
//  §1 the fixture bundled extension appears on a fresh home as
//     <name>@mercury, approved (installing Mercury is the approval),
//     switched on by its default, `● on` — from the built binary.
//  §2 `disable` turns it off (the settings key is written; it contributes
//     nothing after); `enable` turns it back on.
//  §3 `uninstall` is refused; `update` is refused (it updates with Mercury).
//  §4 an availability predicate answering false removes the row ENTIRELY.
//  §5 an unmet need reads ◑ partial with the reason — honest health for
//     Mercury's own.
//  §6 the shipped roster is EMPTY: a fresh home without the fixture input
//     lists no bundled extension.
//  §7 ships in dist: the built bundle carries the new machinery's
//     load-bearing literals and NONE of the retired estate's.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-bundled-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

if (!existsSync(DIST)) {
  console.log('  – dist/mercury.mjs absent — build first: bun run build.ts')
  process.exit(1)
}

const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-bundled')
const FIXTURE_GATED = join(import.meta.dir, 'fixtures', 'fixture-bundled-gated')
const FIXTURE_NEEDS = join(import.meta.dir, 'fixtures', 'fixture-bundled-needs')

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [DIST, ...args], {
      encoding: 'utf8',
      cwd,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: undefined as never,
        CI: undefined as never,
        MERCURY_CONFIG_DIR: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        ...env,
      },
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}
const withFixture = { MERCURY_EXTENSIONS_BUNDLED_FIXTURE: FIXTURE }

console.log('============================================================')
console.log(' bundled extensions — pre-installed, same manifest (built artifact)')
console.log('============================================================')

// ── §6 first: the shipped roster is empty ───────────────────────────────────
console.log('[6] the shipped roster is EMPTY on a fresh home')
{
  const bare = run(['extensions', 'list', '--json'])
  check('list --json exits 0', bare.code === 0, bare.stderr.slice(0, 200))
  const parsed = JSON.parse(bare.stdout.slice(bare.stdout.indexOf('{'))) as { extensions: Array<{ from: string }> }
  check('no bundled row without the fixture input', !parsed.extensions.some(e => e.from === 'mercury'), JSON.stringify(parsed.extensions))
}

// ── §1 the fixture appears, approved, on ────────────────────────────────────
console.log('[1] the fixture bundled extension: <name>@mercury, approved, on')
{
  const listed = run(['extensions', 'list', '--json'], withFixture)
  check('list --json exits 0', listed.code === 0, listed.stderr.slice(0, 200))
  const parsed = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('{'))) as { extensions: Array<{ id: string; from: string; approved: boolean; state: string; trust: string; health: { outcome: string } | null }> }
  const row = parsed.extensions.find(e => e.id === 'bundle-probe@mercury')
  check('the row is bundle-probe@mercury', row !== undefined, parsed.extensions.map(e => e.id).join(','))
  check('installing Mercury is the approval (approved without a card)', row?.approved === true)
  check('on by its default with honest health', row?.trust === 'on' && row?.health?.outcome === 'loads', JSON.stringify(row))
  const record = JSON.parse(readFileSync(join(home, 'extensions', 'installed.json'), 'utf8')) as Record<string, { approval: { at: string } | null; label: string }>
  check('the first-boot approval record is on file', record['bundle-probe@mercury']?.approval !== null && record['bundle-probe@mercury']?.label === 'mercury')
}

// ── §2 the switch ───────────────────────────────────────────────────────────
console.log('[2] disable writes the settings key; enable restores')
{
  const off = run(['extensions', 'disable', 'bundle-probe@mercury'], withFixture)
  check('disable exits 0', off.code === 0, off.stderr.slice(0, 120))
  const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { extensions?: { enabled?: Record<string, boolean> } }
  check('the switch lives under extensions.enabled["bundle-probe@mercury"]', settings.extensions?.enabled?.['bundle-probe@mercury'] === false)
  const listed = run(['extensions', 'list', '--json'], withFixture)
  const parsed = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('{'))) as { extensions: Array<{ id: string; trust: string }> }
  check('the row reads off', parsed.extensions.find(e => e.id === 'bundle-probe@mercury')?.trust === 'off')
  const on = run(['extensions', 'enable', 'bundle-probe@mercury'], withFixture)
  check('enable exits 0 and restores', on.code === 0)
}

// ── §3 uninstall and update are not offered ─────────────────────────────────
console.log('[3] a bundled row cannot be uninstalled or updated')
{
  const un = run(['extensions', 'uninstall', 'bundle-probe@mercury', '--yes'], withFixture)
  check('uninstall refuses with the reason (exit 1)', un.code === 1 && (un.stderr + un.stdout).includes('bundled'), (un.stderr + un.stdout).slice(0, 160))
  const up = run(['extensions', 'update', 'bundle-probe@mercury'], withFixture)
  check('update refuses: it updates with Mercury', up.code === 1 && (up.stderr + up.stdout).includes('updates with Mercury'), (up.stderr + up.stdout).slice(0, 160))
}

// ── §4 availability ─────────────────────────────────────────────────────────
console.log('[4] an availability predicate answering false removes the row entirely')
{
  const listed = run(['extensions', 'list', '--json'], { MERCURY_EXTENSIONS_BUNDLED_FIXTURE: FIXTURE_GATED })
  const parsed = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('{'))) as { extensions: Array<{ id: string }> }
  check('no row, no ghost', !parsed.extensions.some(e => e.id === 'gated-probe@mercury'), JSON.stringify(parsed.extensions.map(e => e.id)))
}

// ── §5 honest health ────────────────────────────────────────────────────────
console.log('[5] a bundled extension with an unmet need reads partial with the reason')
{
  const listed = run(['extensions', 'list', '--json'], { MERCURY_EXTENSIONS_BUNDLED_FIXTURE: FIXTURE_NEEDS })
  const parsed = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('{'))) as { extensions: Array<{ id: string; health: { outcome: string; reasons: string[] } | null }> }
  const row = parsed.extensions.find(e => e.id === 'needs-probe@mercury')
  check('the row reads partial', row?.health?.outcome === 'partial', JSON.stringify(row))
  check('the reason names the missing binary', row?.health?.reasons.some(r => r === 'fixture-binary-that-does-not-exist not on PATH') === true)
}

// ── §7 ships in dist ────────────────────────────────────────────────────────
console.log('[7] the built bundle carries the new literals and none of the retired ones')
{
  const dist = readFileSync(DIST, 'utf8')
  const J = (...parts: string[]): string => parts.join('')
  for (const literal of ['mercury-extension.json', 'mercury-extensions.json', 'MERCURY_EXTENSION_ROOT', 'MERCURY_EXTENSION_DATA'] as const) {
    check(`dist carries ${literal}`, dist.includes(literal))
  }
  check('dist carries the ext: server prefix helper', dist.includes(J('ext', ':')))
  check('dist carries the record files', dist.includes('installed.json') && dist.includes('sources.json'))
  // The retired estate's load-bearing literals: OUR files and keys — a bare
  // generic word cannot be a dist law (third-party bundled code speaks it).
  for (const [label, needle] of [
    ['the retired manifest dir', J('.mercury', '-plug', 'in')],
    ['the retired registry file', J('known_', 'market', 'places.json')],
    ['the retired installed table', J('installed_', 'plug', 'ins.json')],
    ['the retired enabled key', J('enabled', 'Plug', 'ins')],
    ['the retired extension-server prefix helper', J('plug', 'in:${')],
  ] as const) {
    check(`dist ships no ${label}`, !dist.includes(needle))
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ BUNDLED EXTENSIONS — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
