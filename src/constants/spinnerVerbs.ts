// ============================================================================
//  src/constants/spinnerVerbs.ts — spinner vocabulary + composition + the
//  fresh-pick sampler. COMPOSITION IS DETERMINISTIC; only the pick is
//  random (a per-call random composition once made two spinners in the same
//  turn disagree about which vocabulary existed at all).
//
//  Cadence laws for every entry: no trailing punctuation (the spinner
//  appends its own ellipsis/dots), no emoji, no exclamation marks, and
//  ORIGINAL house writing only — never a quoted or lightly reworded lyric.
// ============================================================================
import { randomInt } from 'node:crypto'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { isScribeModeOn } from '../utils/scribeMode.js'

export type QuicksilverMode = 'off' | 'mixed' | 'only'

/**
 * MERCURY_HIP through the registry's env reader: '0'/'false' → off;
 * '1'/'true' → only; anything else including unset → mixed. Read live on
 * every call — no caching.
 */
export function quicksilverMode(): QuicksilverMode {
  const raw = flagEnv('MERCURY_HIP')
  if (raw === '0' || raw === 'false') return 'off'
  if (raw === '1' || raw === 'true') return 'only'
  return 'mixed'
}

// The Mercury desert vocabulary (the default base list).
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

// The base verb list: the opt-out vocabulary; the only
// behavioural requirements are non-empty, single words, no trailing
// punctuation.
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

// ORIGINAL house writing — the quicksilver main set. The first interjection
// is the marker line provers detect the cadence by.
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

// ORIGINAL house writing — the terminal/code-flavoured adjacent set.
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

// ORIGINAL house writing — the longer-line flow set.
export const MERCURY_QUICKSILVER_FLOW: readonly string[] = [
  'Talk less, ship more',
  'Heads down, wheels up',
  'One take, no rehearsal',
  'Fast hands, clean lines',
  'Momentum is the plan',
  'Straight line to done',
]

/** The quicksilver set: main + code + flow, in that order. */
const QUICKSILVER_SET: readonly string[] = [
  ...MERCURY_QUICKSILVER,
  ...MERCURY_QUICKSILVER_CODE,
  ...MERCURY_QUICKSILVER_FLOW,
]

let quicksilverLookup: Set<string> | null = null

/** Membership probe for the spinner glyph's frame-walk swing; the lookup
 *  set is built lazily once per process. */
export function isQuicksilverLine(verb: string): boolean {
  if (quicksilverLookup === null) quicksilverLookup = new Set(QUICKSILVER_SET)
  return quicksilverLookup.has(verb)
}

/**
 * Deterministic pool composition: base list (desert unless
 * MERCURY_DESERT_VERBS reads exactly '0'), then the quicksilver fold by
 * mode — off → base alone; only → quicksilver alone; mixed → base plus
 * quicksilver, and in an identity-forward mode (scribe) base plus
 * quicksilver TWICE (a ~2:1 weighting). An explicit
 * '0' always beats any mode. A `spinnerVerbs` setting overlays last:
 * replace-with-verbs wins when non-empty, any other mode appends.
 */
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
  } else if (isScribeModeOn()) {
    pool = [...desert, ...quicksilver, ...quicksilver]
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

/** The default verb when even the pool is empty. */
const FALLBACK_VERB = 'Thinking'

// A process-wide ring of the last 16 picks across every consumer (leader
// turns, brief mode, teammate spawns).
const RECENT_PICKS: string[] = []
const RECENT_WINDOW = 16

/**
 * Fresh-pick sampler: the exclusion window is min(16, floor(pool/2)) —
 * capped at half the pool so tiny custom pools degrade gracefully (a
 * two-entry pool alternates; a one-entry pool repeats honestly). Candidates
 * are the pool minus the recent window; empty candidates fall back to the
 * whole pool. The pool argument is defaulted, so a caller passing nothing
 * recomputes the pool per pick.
 */
export function sampleSpinnerVerb(pool: string[] = getSpinnerVerbs()): string {
  const window = Math.min(RECENT_WINDOW, Math.floor(pool.length / 2))
  const recent = new Set(RECENT_PICKS.slice(-window))
  const candidates = pool.filter(verb => !recent.has(verb))
  const sampleFrom = candidates.length > 0 ? candidates : pool
  // crypto randomInt: the module carries no Math.random call (pinned).
  const picked = sampleFrom.length > 0 ? (sampleFrom[randomInt(sampleFrom.length)] ?? FALLBACK_VERB) : FALLBACK_VERB
  RECENT_PICKS.push(picked)
  while (RECENT_PICKS.length > RECENT_WINDOW) RECENT_PICKS.shift()
  return picked
}

/** The base list stays exported under its original name. */
export const SPINNER_VERBS: string[] = [...STOCK_VERBS]
