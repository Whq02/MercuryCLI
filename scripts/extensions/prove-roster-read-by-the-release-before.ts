#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-release-before-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const paths = await import('../../src/integrations/extensions/paths.ts')
const sources = await import('../../src/integrations/extensions/sources.ts')
const install = await import('../../src/integrations/extensions/install.ts')
const rosterMod = await import('../../src/integrations/extensions/roster.ts')
const reloadMod = await import('../../src/integrations/extensions/reload.ts')
const activeMod = await import('../../src/integrations/extensions/active.ts')
const cli = await import('../../src/integrations/extensions/cli.ts')

const RELEASE_BEFORE = '1.0.11'
const RELEASE_BEFORE_SWITCH_KINDS = ['hooks', 'servers', 'language', 'agents', 'skills', 'channels', 'keybindings'] as const
const releaseBeforeRecord = z.object({
  name: z.string(),
  label: z.string(),
  version: z.string(),
  commit: z.string().nullable(),
  contentHash: z.string(),
  contributionsHash: z.string(),
  installedAt: z.string(),
  updatedAt: z.string(),
  path: z.string(),
  previous: z.object({ version: z.string(), path: z.string(), contributionsHash: z.string() }).nullable(),
  approval: z.object({ version: z.string(), contributionsHash: z.string(), at: z.string() }).nullable(),
  switches: z.object(Object.fromEntries(RELEASE_BEFORE_SWITCH_KINDS.map(kind => [kind, z.boolean()]))),
  pendingFirstLoad: z.boolean().optional(),
  pendingUpdate: z.object({ version: z.string(), path: z.string(), contributionsHash: z.string(), commit: z.string().nullable() }).nullable().optional(),
  bundledNote: z.string().nullable().optional(),
})

const WHERE_TO_FIX = `the released ${RELEASE_BEFORE} is what mercury update --rollback returns to, and it reads this file with the shape held above; keep every switch kind it requires in what writeInstalled writes (withChannelsSwitch in src/integrations/extensions/records.ts), keep what readInstalled does not know (the loose InstalledRecordSchema and SwitchesSchema there), and let a start restore a kind an entry has lost (restoreChannelsSwitches, called by computeRoster in src/integrations/extensions/roster.ts)`

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

type Roster = Record<string, { path: string; switches: Record<string, unknown>; [field: string]: unknown }>
const rosterText = (): string => readFileSync(paths.getInstalledFile(), 'utf8')
const roster = (): Roster => JSON.parse(rosterText()) as Roster
const writeRoster = (next: Roster): void => writeFileSync(paths.getInstalledFile(), JSON.stringify(next, null, 2) + '\n')

function releaseBeforeSays(): string {
  for (const [id, value] of Object.entries(roster())) {
    const parsed = releaseBeforeRecord.safeParse(value)
    if (!parsed.success) return `installed.json unreadable (installed.json: "${id}": ${parsed.error.issues[0]?.message ?? 'invalid record'})`
  }
  return ''
}
function readable(label: string): void {
  const says = releaseBeforeSays()
  check(label, says === '', `the released ${RELEASE_BEFORE} would say: ${says}`)
}

const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
const OWN = 'kitchen-sink@fixture-source'

console.log('============================================================')
console.log(` the roster this version writes is read by the released ${RELEASE_BEFORE}`)
console.log('============================================================')

console.log('[1] an entry this version creates: a new bundled copy and a newly installed extension')
{
  rosterMod.computeRoster({ cwd })
  const bundled = Object.keys(roster()).filter(id => id.endsWith('@mercury'))
  check('the first start records the bundled copies', bundled.length > 0, 'computeRoster wrote no bundled entry to installed.json')
  readable('the roster of bundled copies is readable')
  check('the fixture source adds', (await sources.addSource(FIXTURE, { label: 'fixture-source' })).ok)
  check('the extension installs and is approved', (await install.installFromSource('fixture-source', 'kitchen-sink')).ok && install.approve(OWN).ok)
  readable('the roster with the new extension is readable')
  const made = roster()
  check(
    'every created entry holds every switch kind of the release before, on',
    Object.values(made).every(record => RELEASE_BEFORE_SWITCH_KINDS.every(kind => record.switches[kind] === true)),
    'switches written: ' + JSON.stringify(Object.fromEntries(Object.entries(made).map(([id, record]) => [id, Object.keys(record.switches)]))),
  )
}

console.log(`[2] a rewrite keeps what the released ${RELEASE_BEFORE} wrote and this version does not know`)
{
  const seeded = roster()
  const bundledId = Object.keys(seeded).find(id => id.endsWith('@mercury'))!
  const ownPath = seeded[bundledId]!.path
  seeded[OWN]!.switches['channels'] = false
  seeded[bundledId]!.switches['channels'] = false
  seeded[bundledId]!.path = ownPath.replace(/[^/\\]+$/, `${RELEASE_BEFORE}-0000000000000000`)
  seeded[OWN]!['fieldOfAnotherVersion'] = 'kept'
  seeded[OWN]!.switches['kindOfAnotherVersion'] = false
  writeRoster(seeded)
  rosterMod.computeRoster({ cwd })
  check('the start rewrote the bundled entry (its copy moved to this version)', roster()[bundledId]?.path === ownPath, `path on file: ${roster()[bundledId]?.path}`)
  check('a switch of the own extension is turned off', install.setKindSwitch(OWN, 'hooks', false).ok)
  const kept = roster()
  readable('the rewritten roster is readable')
  check('the rewritten bundled entry keeps the switch the release before turned off', kept[bundledId]?.switches['channels'] === false, `channels on file: ${String(kept[bundledId]?.switches['channels'])}`)
  check('the rewritten own entry keeps it too, beside the switch this version turned off', kept[OWN]?.switches['channels'] === false && kept[OWN]?.switches['hooks'] === false, JSON.stringify(kept[OWN]?.switches))
  check('a field and a switch kind this version does not know are kept', kept[OWN]?.['fieldOfAnotherVersion'] === 'kept' && kept[OWN]?.switches['kindOfAnotherVersion'] === false, JSON.stringify(kept[OWN]))
}

console.log('[3] a roster that has already lost the kind gets it back at the next start, and only then is it rewritten')
{
  const lost = roster()
  for (const record of Object.values(lost)) delete record.switches['channels']
  writeRoster(lost)
  check('the seeded roster is the unreadable one', releaseBeforeSays().includes('expected boolean, received undefined'), `the released ${RELEASE_BEFORE} would say: ${releaseBeforeSays() || 'nothing'}`)
  rosterMod.computeRoster({ cwd })
  readable('one start makes it readable again')
  check('every entry got the kind back, on', Object.values(roster()).every(record => record.switches['channels'] === true), 'channels on file: ' + JSON.stringify(Object.fromEntries(Object.entries(roster()).map(([id, record]) => [id, record.switches['channels'] ?? 'absent']))))
  const healed = rosterText()
  rosterMod.computeRoster({ cwd })
  check('a start with nothing to restore leaves the file byte-identical', rosterText() === healed, 'computeRoster rewrote a roster that lacked nothing')
}

console.log('[4] this version has no channels switch: it lists none and counts none')
{
  const reloaded = await reloadMod.reloadExtensions({ cwd })
  check('the reload counts and its line name no channels', !Object.keys(reloaded.counts).includes('channels') && !reloaded.line.includes('channel'), `${JSON.stringify(reloaded.counts)} · ${reloaded.line}`)
  rosterMod.setActiveSnapshot(null)
  activeMod.publishActiveSet(null)
  check('the rows of extensions list --json name no channels', !JSON.stringify(cli.listRows()).includes('channels'), JSON.stringify(cli.listRows().rows.map(row => row.id)))
}

removeScratch(scratch)
console.log(failures === 0 ? '\n ✅ ROSTER READ BY THE RELEASE BEFORE — GREEN' : `\n ❌ ${failures} FAILED — ${WHERE_TO_FIX}`)
process.exit(failures === 0 ? 0 : 1)
