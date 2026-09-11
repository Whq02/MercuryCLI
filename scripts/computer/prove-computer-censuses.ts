#!/usr/bin/env bun
import { check, finish, section, sourceText } from './computerProofKit.ts'
import { COMPUTER_ACTIONS } from './computerToolKit.ts'

const { CAPABILITY_UNITS } = await import('../../src/utils/capability/census.ts')
const { EXECUTION_DOMAIN_CENSUS } = await import('../../src/services/primitives/executionCensus.ts')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
const state = await import('../../src/bootstrap/state.ts')

interface CensusRow {
  name: string
  cancellation: string
  deferred: boolean
  operations: string[] | null
  units: string[]
}

section('§1 the committed tool census carries the Computer row')
{
  const census = JSON.parse(sourceText('scripts/builtin-tools/fixtures/tool-census.json')) as { rows: CensusRow[] }
  const row = census.rows.find(r => r.name === 'Computer')
  check('the row exists', row !== undefined)
  check("cancellation 'cancel' and deferred true", row?.cancellation === 'cancel' && row?.deferred === true, JSON.stringify(row))
  check('the fourteen operations in order', JSON.stringify(row?.operations) === JSON.stringify(COMPUTER_ACTIONS), JSON.stringify(row?.operations))
  check("the unit 'desktop-drive'", row?.units.includes('desktop-drive') === true, JSON.stringify(row?.units))
  const markdown = sourceText('scripts/builtin-tools/fixtures/tool-census.md')
  check('the markdown census names the row too', markdown.includes('Computer'))
}

section('§2 the capability unit and the execution domain')
{
  check("CAPABILITY_UNITS carries 'desktop-drive'", (CAPABILITY_UNITS as readonly string[]).includes('desktop-drive'))
  const domain = EXECUTION_DOMAIN_CENSUS.find(e => e.domain === 'desktop-session')
  check("EXECUTION_DOMAIN_CENSUS carries 'desktop-session' with the desktop session as its adapter", domain !== undefined && String((domain as { adapter?: string }).adapter ?? '').includes('desktopSession'), JSON.stringify(domain))
}

section('§3 the flag rows')
{
  const byEnv = new Map(FLAG_REGISTRY.map(f => [f.env, f]))
  const gate = byEnv.get('MERCURY_COMPUTER_USE')
  check("MERCURY_COMPUTER_USE is a default-on row on the security tier with the suite as evidence", gate?.kind === 'default-on' && gate.tier === 'security' && gate.evidence === 'scripts/computer/run-all.sh', JSON.stringify(gate))
  check('its off words name =0, the catalog and the untouched driver', /=0/.test(gate?.off ?? '') && /catalog/.test(gate?.off ?? '') && /driver/.test(gate?.off ?? ''), gate?.off)
  check("MERCURY_DESKTOP_DRIVER is a value row consumed by the resolver", byEnv.get('MERCURY_DESKTOP_DRIVER')?.kind === 'value' && (byEnv.get('MERCURY_DESKTOP_DRIVER')?.consumer ?? '').includes('resolveDriver'))
  check("MERCURY_DESKTOP_FAKE_SCENE and MERCURY_DESKTOP_FAKE_LOG are value rows consumed by the fake driver", byEnv.get('MERCURY_DESKTOP_FAKE_SCENE')?.kind === 'value' && byEnv.get('MERCURY_DESKTOP_FAKE_LOG')?.kind === 'value' && byEnv.get('MERCURY_DESKTOP_FAKE_SCENE')?.consumer === 'src/services/desktop/fakeDesktopDriver.ts' && byEnv.get('MERCURY_DESKTOP_FAKE_LOG')?.consumer === 'src/services/desktop/fakeDesktopDriver.ts')
  check("MERCURY_DESKTOP_PACK_DIR is a value row consumed by the pack owner", byEnv.get('MERCURY_DESKTOP_PACK_DIR')?.kind === 'value' && (byEnv.get('MERCURY_DESKTOP_PACK_DIR')?.consumer ?? '').includes('desktop/pack'))
  const interacting = ['MERCURY_COMPUTER_USE', 'MERCURY_DESKTOP_DRIVER', 'MERCURY_DESKTOP_FAKE_SCENE', 'MERCURY_DESKTOP_FAKE_LOG']
  let symmetric = true
  for (const env of interacting) {
    for (const ref of byEnv.get(env)?.interactsWith ?? []) {
      if (!(byEnv.get(ref)?.interactsWith ?? []).includes(env)) symmetric = false
    }
  }
  check('the computer-use rows interact symmetrically', symmetric)
}

section('§4 the AppState stub is gone and the state facade gained nothing')
{
  const store = sourceText('src/state/AppStateStore.ts')
  check("AppStateStore.ts no longer spells 'computerUseSession'", !store.includes('computerUseSession'))
  const desktopExports = Object.keys(state).filter(k => /desktop|computer/i.test(k))
  check('src/bootstrap/state.ts exports nothing named for the desktop or the computer tool', desktopExports.length === 0, desktopExports.join(','))
  const contract = sourceText('scripts/core-runtime/prove-state-contract.ts')
  check('the state contract\'s frozen export list names nothing for the desktop or the computer tool', !/EXPECTED_VALUE_EXPORTS[\s\S]*?'[^']*(?:[Dd]esktop|[Cc]omputer)[^']*'/.test(contract.slice(contract.indexOf('EXPECTED_VALUE_EXPORTS'), contract.indexOf('const actual = Object.keys(state)'))))
}

section('§5 the suites are seeded')
{
  const seed = sourceText('scripts/gate/duration-seed.tsv')
  check('duration-seed.tsv carries computer and computer-drives rows', /^computer\t\d+$/m.test(seed) && /^computer-drives\t\d+$/m.test(seed))
}

finish('prove-computer-censuses')
