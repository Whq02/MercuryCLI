#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-install-safety.ts — a hostile version string is
//  a refusal, never a rename.
//
//  §1 the version-to-folder fold REFUSES the spellings whose folded result
//     is a path word (`..`, `.`, empty) with a typed error — the owner
//     enforces, so no caller can aim rmSync above `installed/<id>/`.
//  §2 the install road refuses `..` and `.` versions typed, BEFORE any
//     fetch: nothing is staged, nothing is deleted, every other installed
//     extension is byte-intact — so the loud-exit card's "nothing was
//     changed" stays true by construction (the E008-44 tree kill).
//  §3 the update road (the same rmSync/rename pair) refuses the same
//     spellings with the running version untouched.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-safety-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const paths = await import('../../src/extensions/paths.ts')
const records = await import('../../src/extensions/records.ts')
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

// ── the source: one good extension, three hostile version spellings ─────────
const srcroot = join(scratch, 'srcroot')
function writeExtension(name: string, version: string): void {
  mkdirSync(join(srcroot, name), { recursive: true })
  writeFileSync(join(srcroot, name, 'mercury-extension.json'), JSON.stringify({ name, version, description: `${name} fixture` }))
}
function writeCatalogue(versions: Record<string, string>): void {
  writeFileSync(join(srcroot, 'mercury-extensions.json'), JSON.stringify({
    name: 'local', description: 'install-safety fixture source',
    extensions: Object.entries(versions).map(([name, version]) => ({ name, version, description: `${name} fixture`, path: `./${name}` })),
  }))
}
writeExtension('good', '1.0.0')
writeExtension('vtrav', '..')
writeExtension('vdot', '.')
writeExtension('goodb', '1.0.0')
writeExtension('goodc', '1.0.0')
writeCatalogue({ good: '1.0.0', vtrav: '..', vdot: '.', goodb: '1.0.0', goodc: '1.0.0' })

function refusedTyped(fn: () => string): { threw: boolean; typed: boolean; name: string } {
  try {
    fn()
    return { threw: false, typed: false, name: '' }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const exported = (paths as Record<string, unknown>)['VersionFolderTraversalError']
    const typed = name === 'VersionFolderTraversalError' && typeof exported === 'function' && error instanceof (exported as new (...args: never[]) => Error)
    return { threw: true, typed, name }
  }
}

console.log('============================================================')
console.log(' install safety — a hostile version is a refusal, not a rename')
console.log('============================================================')

// ── §1 the fold owner refuses ───────────────────────────────────────────────
console.log('[1] versionFolderName refuses the path words typed')
{
  for (const hostile of ['..', '.', '']) {
    const r = refusedTyped(() => paths.versionFolderName(hostile))
    check(`'${hostile}' throws the typed refusal`, r.threw && r.typed, r.threw ? `threw ${r.name}` : 'returned a folder name')
  }
  for (const legal of ['1.0.0', '2024.1', 'v1', '1.0.0-rc.1', '.hidden']) {
    let folded = ''
    const r = refusedTyped(() => (folded = paths.versionFolderName(legal)))
    check(`'${legal}' still folds`, !r.threw && folded.length > 0, r.threw ? `threw ${r.name}` : '')
  }
  const dirOk = paths.getInstalledVersionDir('good@local', '1.0.0')
  check('the version dir for a legal version is under installed/<id>/', dirOk.includes(join('installed', 'good@local')))
}

// ── §2 the install road ─────────────────────────────────────────────────────
console.log('[2] install: refusal BEFORE any change; the tree stays byte-intact')
{
  const added = await sources.addSource(srcroot, { label: 'local' })
  check('the source adds', added.ok, added.ok ? '' : added.reason)
  const good = await install.installFromSource('local', 'good')
  check('good 1.0.0 installs', good.ok && good.record.version === '1.0.0')
  check('good approves', install.approve('good@local').ok)
  const goodDir = paths.getInstalledVersionDir('good@local', '1.0.0')
  const goodManifestBefore = readFileSync(join(goodDir, 'mercury-extension.json'), 'utf8')

  const trav = await install.installFromSource('local', 'vtrav').catch((error: unknown) => ({ ok: false as const, reason: `THREW: ${error instanceof Error ? error.message : String(error)}` }))
  check('vtrav (version ..) is refused, not installed', !trav.ok, trav.ok ? 'install reported ok' : '')
  check('the refusal names the version-folder law', !trav.ok && /cannot name an install folder/.test(trav.reason), trav.ok ? '' : trav.reason)
  check('installed/ survives whole', existsSync(goodDir), 'the good@local tree is gone')
  check('good is byte-intact', existsSync(join(goodDir, 'mercury-extension.json')) && readFileSync(join(goodDir, 'mercury-extension.json'), 'utf8') === goodManifestBefore)
  const residue = existsSync(paths.getInstalledDir()) ? readdirSync(paths.getInstalledDir()).filter(n => n.startsWith('.installing-')) : []
  check('no staging residue', residue.length === 0, residue.join(' '))
  check('the good record still stands', records.installedOrEmpty()['good@local'] !== undefined)

  const dot = await install.installFromSource('local', 'vdot').catch((error: unknown) => ({ ok: false as const, reason: `THREW: ${error instanceof Error ? error.message : String(error)}` }))
  check('vdot (version .) is refused, not mis-nested', !dot.ok, dot.ok ? 'install reported ok' : '')
  check('nothing landed at the id directory itself', !existsSync(join(paths.getInstalledIdDir('vdot@local'), 'mercury-extension.json')))
}

// ── §3 the update road ──────────────────────────────────────────────────────
console.log('[3] update: the same pair refuses; the running version is untouched')
{
  const b = await install.installFromSource('local', 'goodb')
  check('goodb 1.0.0 installs', b.ok)
  check('goodb approves', install.approve('goodb@local').ok)
  const bDir = paths.getInstalledVersionDir('goodb@local', '1.0.0')
  writeExtension('goodb', '..')
  writeCatalogue({ good: '1.0.0', vtrav: '..', vdot: '.', goodb: '..', goodc: '1.0.0' })
  const upTrav = await install.update('goodb@local').catch((error: unknown) => ({ ok: false as const, reason: `THREW: ${error instanceof Error ? error.message : String(error)}` }))
  check('update to version .. is refused typed', !upTrav.ok && /cannot name an install folder/.test((upTrav as { reason?: string }).reason ?? ''), upTrav.ok ? 'update reported ok' : (upTrav as { reason?: string }).reason)
  check('the running 1.0.0 stays', existsSync(bDir))
  check('installed/ survives the update road', existsSync(paths.getInstalledVersionDir('good@local', '1.0.0')))
  const residue = existsSync(paths.getInstalledDir()) ? readdirSync(paths.getInstalledDir()).filter(n => n.startsWith('.updating-')) : []
  check('no update staging residue', residue.length === 0, residue.join(' '))

  const c = await install.installFromSource('local', 'goodc')
  check('goodc 1.0.0 installs', c.ok)
  check('goodc approves', install.approve('goodc@local').ok)
  const cDir = paths.getInstalledVersionDir('goodc@local', '1.0.0')
  writeExtension('goodc', '.')
  writeCatalogue({ good: '1.0.0', vtrav: '..', vdot: '.', goodb: '..', goodc: '.' })
  const upDot = await install.update('goodc@local').catch((error: unknown) => ({ ok: false as const, reason: `THREW: ${error instanceof Error ? error.message : String(error)}` }))
  check('update to version . is refused typed', !upDot.ok && /cannot name an install folder/.test((upDot as { reason?: string }).reason ?? ''), upDot.ok ? 'update reported ok' : (upDot as { reason?: string }).reason)
  check('the running goodc 1.0.0 stays', existsSync(cDir) && existsSync(join(cDir, 'mercury-extension.json')))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ INSTALL SAFETY — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
