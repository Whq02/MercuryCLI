import { randomInt } from 'node:crypto'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getInitialSettings } from '../utils/settings/settings.js'

export type QuicksilverMode = 'off' | 'mixed' | 'only'

export function quicksilverMode(): QuicksilverMode {
  const raw = flagEnv('MERCURY_HIP')
  if (raw === '0' || raw === 'false') return 'off'
  if (raw === '1' || raw === 'true') return 'only'
  return 'mixed'
}

const MERCURY_DESERT_VERBS: readonly string[] = [
  'Scuttling',
  'Sunbaking',
  'Dune-running',
  'Mirage-testing',
  'Oasis-hopping',
  'Sidewinding',
  'Burrowing',
  'Wind-carving',
  'Sand-sifting',
  'Ridge-walking',
  'Shade-hunting',
  'Star-steering',
  'Cactus-counting',
  'Canyon-echoing',
  'Heat-shimmering',
  'Tumbleweeding',
  'Salt-flat-gliding',
  'Arroyo-tracing',
  'Basking',
  'Molting',
]

const STOCK_VERBS: readonly string[] = [
  'Thinking',
  'Working',
  'Considering',
  'Building',
  'Composing',
  'Drafting',
  'Weighing',
  'Checking',
  'Reading',
  'Tracing',
  'Digging',
  'Sorting',
  'Mapping',
  'Shaping',
  'Untangling',
  'Assembling',
  'Polishing',
  'Reviewing',
  'Testing',
  'Sketching',
  'Refining',
  'Connecting',
  'Balancing',
  'Measuring',
  'Arranging',
  'Distilling',
  'Focusing',
  'Combing',
  'Weaving',
  'Tuning',
]

const MERCURY_QUICKSILVER: readonly string[] = [
  'Quicksilver',
  'Molten',
  'White-hot',
  'Full tilt',
  'No brakes',
  'Sparks up',
  'Live wire',
  'Heat rising',
  'Straight through',
  'Zero drag',
]

export const MERCURY_QUICKSILVER_CODE: readonly string[] = [
  'Shipping heat',
  'Diff on fire',
  'Green across',
  'Branch ablaze',
  'Bytes at speed',
  'Stack lit',
  'Cursor blur',
  'Compile and go',
]

export const MERCURY_QUICKSILVER_FLOW: readonly string[] = [
  'Talk less, ship more',
  'Heads down, wheels up',
  'One take, no rehearsal',
  'Fast hands, clean lines',
  'Momentum is the plan',
  'Straight line to done',
]

const QUICKSILVER_SET: readonly string[] = [
  ...MERCURY_QUICKSILVER,
  ...MERCURY_QUICKSILVER_CODE,
  ...MERCURY_QUICKSILVER_FLOW,
]

let quicksilverLookup: Set<string> | null = null

export function isQuicksilverLine(verb: string): boolean {
  if (quicksilverLookup === null) quicksilverLookup = new Set(QUICKSILVER_SET)
  return quicksilverLookup.has(verb)
}

export function getSpinnerVerbs(): string[] {
  const desert: readonly string[] =
    flagEnv('MERCURY_DESERT_VERBS') === '0' ? STOCK_VERBS : MERCURY_DESERT_VERBS
  const mode = quicksilverMode()
  const quicksilver = QUICKSILVER_SET
  let pool: string[]
  if (mode === 'off') {
    pool = [...desert]
  } else if (mode === 'only') {
    pool = [...quicksilver]
  } else {
    pool = [...desert, ...quicksilver]
  }
  const setting = getInitialSettings().spinnerVerbs
  if (setting) {
    if (setting.mode === 'replace') {
      return setting.verbs.length > 0 ? [...setting.verbs] : pool
    }
    return [...pool, ...setting.verbs]
  }
  return pool
}

const FALLBACK_VERB = 'Thinking'

const RECENT_PICKS: string[] = []
const RECENT_WINDOW = 16

export function sampleSpinnerVerb(pool: string[] = getSpinnerVerbs()): string {
  const window = Math.min(RECENT_WINDOW, Math.floor(pool.length / 2))
  const recent = new Set(RECENT_PICKS.slice(-window))
  const candidates = pool.filter(verb => !recent.has(verb))
  const sampleFrom = candidates.length > 0 ? candidates : pool
  const picked = sampleFrom.length > 0 ? (sampleFrom[randomInt(sampleFrom.length)] ?? FALLBACK_VERB) : FALLBACK_VERB
  RECENT_PICKS.push(picked)
  while (RECENT_PICKS.length > RECENT_WINDOW) RECENT_PICKS.shift()
  return picked
}

export const SPINNER_VERBS: string[] = [...STOCK_VERBS]
