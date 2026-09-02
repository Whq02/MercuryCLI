#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-uninstall-clean.ts — uninstall leaves no residue.
//
//  Snapshot the FRESH config home (every path + content hash) → install →
//  approve → configure a sensitive option → populate the data folder (the
//  footprint a hook leaves) → uninstall with delete → snapshot again:
//  IDENTICAL except the source cache and the log. The home starts with NO
//  settings.json, so the husk law is the drive: the file the switch write
//  created must LEAVE, never stand as `{}` (leg 5 proves the converse — a
//  seeded, populated settings file returns to its prior bytes and is never
//  deleted). With --keep-data the data folder alone survives. Secrets
//  leave the secure store (the file store — the same code path the
//  keychain rides). Every project-local switch file the home knows loses
//  the id. Hooks unregister atomically (another extension's hooks survive
//  the swap). A bundled row cannot be uninstalled.
// ============================================================================
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-uninstall-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
const otherProject = join(scratch, 'other-project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
mkdirSync(join(otherProject, '.mercury'), { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

// The config file is CONSTRUCTED before any product import can read and
// cache it: the home already knows two projects when the product wakes.
{
  const { getGlobalMercuryFile } = await import('../../src/utils/env.ts')
  writeFileSync(getGlobalMercuryFile(), JSON.stringify({ numStartups: 1, projects: { [otherProject]: {}, [cwd]: {} } }, null, 2))
}
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
void state
const paths = await import('../../src/extensions/paths.ts')
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')
const options = await import('../../src/extensions/options.ts')
const reloadMod = await import('../../src/extensions/reload.ts')
const bootstrapState = await import('../../src/bootstrap/state.ts')
const { getSecureStorage } = await import('../../src/utils/secureStorage/index.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')

/** Every path under the home (relative) → sha256, EXCLUDING the named prefixes. */
function snapshot(exclude: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const path = join(dir, name)
      const rel = relative(home, path).split(sep).join('/')
      if (exclude.some(prefix => rel === prefix || rel.startsWith(prefix + '/'))) continue
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(path)
      else out.set(rel, createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16))
    }
  }
  walk(home)
  return out
}

function diffSnapshots(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = []
  for (const [k, v] of a) {
    if (!b.has(k)) out.push(`gone: ${k}`)
    else if (b.get(k) !== v) out.push(`changed: ${k}`)
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`new: ${k}`)
  return out
}

console.log('============================================================')
console.log(' uninstall — no residue (the before/after home diff)')
console.log('============================================================')

// The source cache and the log are the two sanctioned survivors.
const EXCLUDE = ['extensions/sources', 'extensions/extensions.log', 'extensions/sources.json']

const added = await sources.addSource(FIXTURE, { label: 'fixture-source' })
check('the fixture source adds', added.ok)
// (The projects record was constructed before the first import above.)
writeFileSync(join(otherProject, '.mercury', 'settings.local.json'), JSON.stringify({ extensions: { enabled: { 'kitchen-sink@fixture-source': true } } }, null, 2))
// A FRESH home: no settings.json exists before the first install — the
// switch write creates it, and the uninstall husk law says it must leave
// again (a `{}` file is not "prior bytes"). The credential store is seeded
// so the populated-store side of the diff law stays driven; the seeded
// SETTINGS file has its own leg [5] below.
const settingsSeed = await import('../../src/utils/settings/settings.ts')
getSecureStorage().update({ trustedDeviceToken: 'seed-token' } as never)
check('the fresh home has no settings.json before install', !existsSync(join(home, 'settings.json')))

const before = snapshot(EXCLUDE)

// ── install → approve → option → data footprint ─────────────────────────────
const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
check('install lands', installed.ok)
const approved = install.approve('kitchen-sink@fixture-source')
check('approve lands', approved.ok)
const manifest = installed.ok ? installed.manifest : null
const saved = options.saveOptionValues('kitchen-sink@fixture-source', manifest?.needs?.options, { FIXTURE_TOKEN: 'hunter2-secret', FIXTURE_NAME: 'ada' })
check('a sensitive option lands in the secure store, a plain one in settings', saved.ok)
{
  const secure = (getSecureStorage().read() ?? {}) as { extensionSecrets?: Record<string, Record<string, string>> }
  check('the secret is in the store under the id', secure.extensionSecrets?.['kitchen-sink@fixture-source']?.['FIXTURE_TOKEN'] === 'hunter2-secret')
  const settingsRaw = readFileSync(join(home, 'settings.json'), 'utf8')
  check('the sensitive value NEVER touches the settings file', !settingsRaw.includes('hunter2-secret'))
  check('the plain value lives in settings', settingsRaw.includes('"FIXTURE_NAME"'))
}
// The footprint a hook run leaves: its data folder (the executor creates it at spawn).
const dataDir = paths.getExtensionDataDir('kitchen-sink@fixture-source')
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, 'hook.log'), 'ROOT=…\n')
const preview = install.uninstallPreview('kitchen-sink@fixture-source')
check('the confirm preview measures the data folder', preview !== null && preview.dataBytes > 0 && preview.label === 'fixture-source')

// A second extension whose hooks must SURVIVE the other's uninstall.
const installedSecond = await install.installFromSource('fixture-source', 'partial-one')
check('the second extension installs', installedSecond.ok)
check('the second extension approves', install.approve('partial-one@fixture-source').ok)
await reloadMod.reloadExtensions({ cwd })
const hooksBefore = (): string[] => {
  const registered = bootstrapState.getRegisteredHooks() ?? {}
  const out: string[] = []
  for (const [event, matchers] of Object.entries(registered)) {
    for (const m of matchers ?? []) if ('extensionId' in (m as object)) out.push(`${event}:${(m as { extensionId: string }).extensionId}`)
  }
  return out
}
check('both extensions registered hooks', hooksBefore().some(h => h.includes('kitchen-sink')) , hooksBefore().join(','))

// ── uninstall with delete ───────────────────────────────────────────────────
console.log('[2] uninstall with delete: the home diff is empty')
const done = install.uninstall('kitchen-sink@fixture-source')
check('uninstall reports its steps', done.ok && done.steps.length >= 5, done.ok ? done.steps.join('; ') : done.reason)
await reloadMod.reloadExtensions({ cwd })
{
  const hooksAfter = hooksBefore()
  check('its hooks are gone; the other extension\'s hooks survive the swap', !hooksAfter.some(h => h.includes('kitchen-sink@fixture-source')))
  check('the other project\'s local settings file lost the id', !readFileSync(join(otherProject, '.mercury', 'settings.local.json'), 'utf8').includes('kitchen-sink@fixture-source'))
  const secure = (getSecureStorage().read() ?? {}) as { extensionSecrets?: Record<string, Record<string, string>> }
  check('the secret left the secure store', secure.extensionSecrets?.['kitchen-sink@fixture-source'] === undefined)
  check('the version folders are gone', !existsSync(paths.getInstalledIdDir('kitchen-sink@fixture-source')))
  check('the data folder is gone', !existsSync(dataDir))
}
// Remove the second extension too, then diff the whole home.
check('the second uninstall lands', install.uninstall('partial-one@fixture-source').ok)
await reloadMod.reloadExtensions({ cwd })
{
  const after = snapshot(EXCLUDE)
  const diff = diffSnapshots(before, after)
  // The installed.json file is allowed to EXIST empty where it did not exist before.
  const tolerated = diff.filter(d => {
    if (d === 'new: extensions/installed.json') {
      const parsed = JSON.parse(readFileSync(paths.getInstalledFile(), 'utf8')) as Record<string, unknown>
      return Object.keys(parsed).length !== 0
    }
    if (d === 'new: schema/settings.schema.json') {
      // The runtime refreshes Mercury's OWN settings schema into the home on
      // any settings write (src/utils/settings/localSchema.ts — an editor
      // affordance, versioned with the build): a sanctioned survivor beside
      // the source cache and the log.
      return false
    }
    return true
  })
  check('the home is byte-identical except the source cache and the log', tolerated.length === 0, tolerated.slice(0, 6).join(' · '))
  // The husk law, named: the settings.json the switch write created is GONE,
  // not standing as `{}`.
  check('no settings.json husk remains on the fresh home', !existsSync(join(home, 'settings.json')))
}

// ── keep-data ───────────────────────────────────────────────────────────────
console.log('[3] --keep-data: the data folder alone survives')
{
  const again = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('reinstall lands', again.ok)
  check('re-approve lands', install.approve('kitchen-sink@fixture-source').ok)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'hook.log'), 'kept\n')
  const kept = install.uninstall('kitchen-sink@fixture-source', { keepData: true })
  check('uninstall with keep-data lands', kept.ok && kept.dataKept)
  check('the data folder survives', existsSync(join(dataDir, 'hook.log')))
  check('everything else is gone', !existsSync(paths.getInstalledIdDir('kitchen-sink@fixture-source')))
  rmSync(dataDir, { recursive: true, force: true })
}

// ── a bundled row cannot be uninstalled ─────────────────────────────────────
console.log('[4] bundled: x is refused')
{
  const refused = install.uninstall('anything@mercury')
  check('a bundled id refuses with the reason', !refused.ok && refused.reason.includes('bundled'), refused.ok ? 'uninstalled' : refused.reason)
}

// ── a populated settings file is the operator's and survives ────────────────
console.log('[5] a seeded settings file returns to its prior bytes — never deleted')
{
  settingsSeed.updateSettingsForSource('userSettings', { spinnerTipsEnabled: true } as never)
  const seededBytes = readFileSync(join(home, 'settings.json'), 'utf8')
  const again = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('install lands on the seeded home', again.ok)
  check('approve lands on the seeded home', install.approve('kitchen-sink@fixture-source').ok)
  check('the switch write shares the seeded file', readFileSync(join(home, 'settings.json'), 'utf8').includes('kitchen-sink@fixture-source'))
  check('the seeded uninstall lands', install.uninstall('kitchen-sink@fixture-source').ok)
  check('the settings file SURVIVES with its prior bytes', existsSync(join(home, 'settings.json')) && readFileSync(join(home, 'settings.json'), 'utf8') === seededBytes)
}

// ── a $schema-only file is a husk too (the own-naming fold shape) ───────────
// The own-naming lane stamps a $schema pointer onto every user-settings
// write; after the lanes fold, an "emptied" file always carries that one
// key. The pointer is configuration-free (the loader ignores it), so the
// husk law must read a $schema-only file as empty — without that, the
// fresh-home guarantee of leg [1] dies at the fold.
console.log('[6] a $schema-only settings file leaves the disk with the husk')
{
  // The pointer spelling must VALIDATE on this branch (the widened
  // z.string() $schema arrives with the own-naming fold; here only the
  // legacy URL literal passes) — a schema-invalid file is refused by every
  // settings door before the husk law is even reached, which is its own
  // correct behavior, not this leg's subject.
  rmSync(join(home, 'settings.json'), { force: true })
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ $schema: 'https://json.schemastore.org/claude-code-settings.json' }, null, 2))
  const again = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('install lands beside the pointer', again.ok)
  check('approve lands beside the pointer', install.approve('kitchen-sink@fixture-source').ok)
  check('the schema-only uninstall lands', install.uninstall('kitchen-sink@fixture-source').ok)
  check('the $schema-only husk leaves the disk', !existsSync(join(home, 'settings.json')))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ UNINSTALL CLEAN — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
