import { randomInt } from 'node:crypto'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getInitialSettings } from '../utils/settings/settings.js'

type QuicksilverMode = 'off' | 'mixed' | 'only'

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
  'Dust-devilling',
  'Hot-footing',
  'Scree-skating',
  'Noon-crossing',
  'Mesa-topping',
  'Gulch-jumping',
  'Lizard-darting',
  'Thermal-climbing',
  'Sandstorm-threading',
  'Flint-striking',
  'Rim-skirting',
  'Glare-cutting',
  'Hawk-circling',
  'Ember-kicking',
  'Grit-grinding',
  'Salt-burnt',
  'Sand-slicked',
  'Cairn-sighting',
  'Wash-following',
  'Shale-splitting',
  'Updraft-riding',
  'Trail-scenting',
  'Crevice-probing',
  'Horizon-scanning',
  'Well-sounding',
  'Quartz-chipping',
  'Basin-ranging',
  'Kestrel-hovering',
  'Talus-stepping',
  'Spring-seeking',
  'Ledge-inching',
  'Whetstone-honing',
  'Dusk-pacing',
  'Bedrock-tapping',
  'Gully-scouting',
  'Dew-gathering',
  'Butte-rounding',
  'Tinder-shaving',
  'Haze-piercing',
  'Pebble-turning',
  'Crest-reaching',
  'Seed-winnowing',
  'Boulder-scaling',
  'Shadow-slipping',
  'Silt-panning',
  'Gale-bracing',
  'Track-studying',
  'Caravan-routing',
  'Well-rotating',
  'Cistern-filling',
  'Trough-draining',
  'Camp-striking',
  'Tent-pegging',
  'Rope-coiling',
  'Kiln-firing',
  'Pack-balancing',
  'Flare-watching',
  'Sandbag-stacking',
  'Granary-sealing',
  'Waterskin-topping',
  'Signal-mirroring',
  'Waypoint-marking',
  'Lantern-trimming',
  'Stake-driving',
  'Wadi-bridging',
  'Outpost-relieving',
  'Dune-shoring',
]

const MERCURY_DESERT_PHRASES: readonly string[] = [
  'Parsing the dunes',
  'Hashing the oasis',
  'Compiling the mirage',
  'Encrypting the caravan',
  'Traversing the sandstorm',
  'Optimizing the pyramid',
  'Debugging the sphinx',
  'Reversing the hieroglyphs',
  'Fuzzing the nomad',
  'Injecting the scarab',
  'Exploiting the tomb',
  'Overflowing the Nile',
  'Obfuscating the pharaoh',
  'Tracing the trade routes',
  'Cracking the amulet',
  'Pwning the mummy',
  'Overclocking the sandglass',
  'Jailbreaking the labyrinth',
  'Ciphering the scrolls',
  'Shellcoding the djinn',
  'Bit-shifting the sundial',
  'Polymorphing the serpent',
  'Disassembling the ankh',
  'Hex-editing the sarcophagus',
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
  'Flat out',
  'Blue flame',
  'Hot iron',
  'Open throttle',
  'Clean strike',
  'Flash point',
  'Redlining',
  'Steel ringing',
  'Razor-edged',
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
  'Hot path',
  'Build glowing',
  'Keys smoking',
  'Pipe at pressure',
  'Patch in flight',
  'Shell at a sprint',
  'Loop at a boil',
  'Diff still warm',
  'Regex at a run',
  'Fans spinning up',
  'Branch at a gallop',
]

export const MERCURY_QUICKSILVER_FLOW: readonly string[] = [
  'Talk less, ship more',
  'Heads down, wheels up',
  'One take, no rehearsal',
  'Fast hands, clean lines',
  'Momentum is the plan',
  'Straight line to done',
  'Eyes up, hands fast',
  'Nothing cools until it ships',
  'Two hands, one direction',
  'Every key pulling weight',
  'Fencing the wolves',
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

function getSpinnerVerbs(): string[] {
  const desert: readonly string[] =
    flagEnv('MERCURY_DESERT_VERBS') === '0' ? STOCK_VERBS : [...MERCURY_DESERT_VERBS, ...MERCURY_DESERT_PHRASES]
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
  const setting = getInitialSettings().activity?.verbs
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
