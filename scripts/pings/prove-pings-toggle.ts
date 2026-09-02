// ============================================================================
//  scripts/pings/prove-pings-toggle.ts — /pings: the
//  bell toggles, the setting saves, nothing repaints it.
//
//  Functional over the REAL command + gate in a scratch config home:
//    §1 the default is ON (a session taps you out of the box);
//    §2 bare /pings TOGGLES (the toggle verb) and the receipt names
//       the new state; on|off set explicitly;
//    §3 the setting is SAVED — a fresh config read agrees (never a cached
//       or repainted value);
//    §4 registration — the command rides the roster and the /config surface
//       carries the honest row (structural).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

// Scratch home BEFORE imports; the VCR/test-env class: NODE_ENV=test would
// reroute saveGlobalConfig onto the in-memory test config — delete it so
// the REAL save path (lock + write + fresh read) is what this proves.
const scratch = mkdtempSync(join(tmpdir(), 'pings-toggle-'))
process.env.HOME = scratch
process.env.MERCURY_CONFIG_DIR = join(scratch, '.mercury')
delete process.env.NODE_ENV
delete process.env.CI
mkdirSync(join(scratch, '.mercury'), { recursive: true })

const { pingsBellEnabled } = await import('../../src/services/pings/pingsGate.js')
const { call } = await import('../../src/commands/pings/pings.js')
const { getGlobalConfig, enableConfigs } = await import('../../src/utils/config.js')
// The boot-order law: config reads are refused until boot flips them on;
// this drive IS the boot here.
enableConfigs()

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

//
section('§1 the default is ON')
//
check('a fresh home rings by default', pingsBellEnabled() === true)

//
section('§2 bare /pings toggles; on|off set explicitly')
//
{
  const r1 = await call('')
  check('bare /pings turns it off', pingsBellEnabled() === false)
  check('the receipt names the quiet state and keeps the rows', r1.type === 'text' && r1.value.includes('pings off') && r1.value.includes('still say'), String((r1 as { value?: string }).value))
  const r2 = await call('')
  check('bare /pings turns it back on', pingsBellEnabled() === true)
  check('the receipt names the ringing state', r2.type === 'text' && r2.value.includes('pings on'), String((r2 as { value?: string }).value))
  await call('off')
  check('/pings off sets off', pingsBellEnabled() === false)
  await call('on')
  check('/pings on sets on', pingsBellEnabled() === true)
  const r3 = await call('sideways')
  check('an unknown argument answers the state without changing it', r3.type === 'text' && r3.value.includes('pings is on') && pingsBellEnabled() === true, String((r3 as { value?: string }).value))
}

//
section('§3 the setting is SAVED — a fresh read agrees')
//
{
  await call('off')
  check('the live config carries the saved value', getGlobalConfig().pingsBell === false)
  const onDisk = JSON.parse(readFileSync(join(scratch, '.mercury', '.mercury.json'), 'utf8')) as { pingsBell?: boolean }
  check('the config file on disk carries it too (saved, not repainted)', onDisk.pingsBell === false, JSON.stringify(onDisk.pingsBell))
  await call('on')
}

//
section('§4 registration — the roster and the honest /config row')
//
{
  const roster = readFileSync(join(ROOT, 'src', 'commands.ts'), 'utf8')
  check(
    'the command rides the roster',
    roster.includes("import pings from './commands/pings/index.js'") && /\n  pings,\n/.test(roster),
  )
  const configSurface = readFileSync(join(ROOT, 'src', 'components', 'Settings', 'Config.tsx'), 'utf8')
  check(
    "/config carries the honest row (id 'pingsBell', reading the saved value)",
    configSurface.includes("id: 'pingsBell'") && configSurface.includes('config.pingsBell !== false'),
  )
  const domains = readFileSync(join(ROOT, 'src', 'components', 'HelpV2', 'commandDomains.ts'), 'utf8')
  check('/help curates the command into a domain', domains.includes("'pings'"))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL PINGS-TOGGLE PROOFS PASS')
else console.log(`${failures} PINGS-TOGGLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
