import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { META_DISPLAY_PINS } from '../../src/services/providers/meta/metaPins.ts'
const root = join(import.meta.dir, '..', '..')
const { MODEL_NAMES } = await import(join(root, 'assets/splash/splash-core.mjs')) as { MODEL_NAMES: Record<string, string> }
const source = readFileSync(join(root, 'assets/splash/mercury-splash.mjs'), 'utf8')
const fn = /function computeModelLabel\(\) \{[\s\S]*?\n\}/.exec(source)?.[0]
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  for (const pin of META_DISPLAY_PINS) check(`the splash derives ${pin.id} from the dated name owner`, MODEL_NAMES[pin.id] === pin.displayName)
  check('the unresolved family word stays Muse, never a speculative account model', MODEL_NAMES.muse === 'Muse')
  check('the standalone label function is present', fn !== undefined)
  const label = (model: string): string => {
    writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({ engine: { model } }))
    return new Function('readFileSync', 'join', 'CONFIG_HOME', 'MODEL_NAMES', `${fn}\nreturn computeModelLabel()`)(readFileSync, join, proofHome, MODEL_NAMES) as string
  }
  check('a saved exact Meta model paints its own display name', label('muse-spark-1.3') === 'Muse Spark 1.3')
  check('a saved family alias does not claim an account catalogue before boot', label('muse') === 'Muse')
  check('an unknown served generation uses the standing raw-id width clamp', label('muse-spark-fixture-unknown') === 'muse-spark-fixture-unknown'.slice(0, 17) + '…')
  check('a Contributor pin keeps its training disclosure', label('muse-spark-1.3-contributor').includes('training permitted'))
  console.log(`META SPLASH GREEN (${count} checks; source-derived labels)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
