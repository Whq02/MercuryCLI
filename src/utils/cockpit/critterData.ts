
import { CLAW, IVORY, OASIS, TERRA } from '../../components/mercuryPalette.js'


export type ArtForm = 'art' | 'hero' | 'mini' | 'square'

type CoreArtForm = 'art' | 'hero' | 'mini'

export type SleepPose = { art: string[]; flow: number }

export type CritterDef = {
  name: string
  hue: string
  hueDeep: string
  mark: { pre: string; core: string; post: string }
  art: string[]
  heroArt?: string[]
  mini: string[]
  markCompact: string[]
  square: string[]
  squareDock: string[]
  sleep: Record<CoreArtForm, SleepPose> & Partial<Record<'square', SleepPose>>
  flow?: Partial<Record<ArtForm, number>>
  settle?: Partial<Record<ArtForm, number>>
  sleepGlyphs?: string
}


export const CR_COLS = 13

export const HERO_ART_COLS = 24


export const EYE_BG = '#EDE8DD'
export const PUPIL = OASIS

export const OCTOPUS_HUE = '#B07BE0'
export const OCTOPUS_HUE_DEEP = '#6E4BA0'
export const JELLYFISH_HUE = '#6FC7E8'
export const JELLYFISH_HUE_DEEP = '#3F7E96'
export const CLAM_HUE = '#16D8B0'
export const CLAM_HUE_DEEP = '#0E9377'
export const EMBER_HUE = '#CE352A'
export const EMBER_HUE_DEEP = '#771A12'

function hexMix(a: string, b: string, t: number): string {
  const p = (h: string): number[] => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [ar, ag, ab] = p(a)
  const [br, bg, bb] = p(b)
  const c = (x: number, y: number): number => Math.round(x + (y - x) * t)
  return (
    '#' +
    [c(ar!, br!), c(ag!, bg!), c(ab!, bb!)]
      .map(v => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

export function cellColor(def: CritterDef, ch: string | undefined): string | undefined {
  switch (ch) {
    case 'M':
      return def.hue
    case 'D':
      return hexMix(def.hue, '#000000', 0.42)
    case 'C':
      return def.hueDeep
    case 'm':
      return hexMix(def.hue, '#000000', 0.2)
    case 'K':
      return hexMix(def.hue, '#000000', 0.72)
    case 'L':
      return hexMix(def.hue, '#FFFFFF', 0.28)
    case '%':
      return hexMix(def.hue, IVORY, 0.45)
    case SLEEP_CELL:
      return hexMix(def.hue, IVORY, 0.45)
    case 'E':
    case 'P':
      return EYE_BG
    default:
      return undefined
  }
}


export const SLEEP_CELL = 'z'

export const SLEEP_PHASES = 3

export const SLEEP_GLYPHS_DEFAULT = 'zzz'

export const SLEEP_GLYPHS_MAX = SLEEP_PHASES + 1

export const CLAM_SLEEP_GLYPHS = 'o°o°'

export function sleepGlyphsFor(def: Pick<CritterDef, 'sleepGlyphs'>): string {
  const g = def.sleepGlyphs
  if (g === undefined) return SLEEP_GLYPHS_DEFAULT
  const n = [...g].length
  return n >= SLEEP_PHASES && n <= SLEEP_GLYPHS_MAX ? g : SLEEP_GLYPHS_DEFAULT
}

export function sleepSlotCountFor(def: Pick<CritterDef, 'sleepGlyphs'>): number {
  return [...sleepGlyphsFor(def)].length
}

export function sleepGlyphAt(def: Pick<CritterDef, 'sleepGlyphs'>, slots: readonly number[], c: number): string {
  const ladder = [...sleepGlyphsFor(def)]
  const i = slots.indexOf(c)
  return ladder[i >= 0 ? i : ladder.length - 1]!
}


const CRAB_ART: string[] = [
  'P.P.......P.P',
  'MMM.......MMM',
  '.MM.......MM.',
  '..MM.MMM.MM..',
  '.MMPMMMMMPMM.',
  '.MMPMMMMMPMM.',
  '.MMMMMMMMMMM.',
  '..MMMMMMMMM..',
  '..LLLLLLLLL..',
  '..LLLLLLLLL..',
  '.C.C.C.C.C.C.',
  'C..C.C.C.C..C',
]

const CRAB_HERO: string[] = [
  '......EEE.....EEE.......',
  '......EKE.....EKE.......',
  '.......DD.....DD........',
  '.......DD.....DD........',
  '.....LLLMMMMMMMMm.CC.CC.',
  '...LLMMMMMMMMMMMMm.CCC..',
  '..LMMMMMMMMMMMMMMMM.CC..',
  '.CCMMMMMMMMMMMMMMMMMC...',
  'CCC.MMMMMMMMMMMMMMMMm...',
  'CCC..MMMMMMMMMMMMMMm....',
  'C.C.mMMMMMMMMMMMMmm.....',
  '....%%%%%%%%%%%%%%......',
  '....%%%%%%%%%%%%%%......',
  '.....DDDDDDDDDDDD.......',
  '...CC..CC....CC..CC.....',
  '...CC..CC....CC..CC.....',
  '...C...C......C...C.....',
  '..CC..CC......CC..CC....',
]

const CRAB_MINI: string[] = [
  '...MMMMM...',
  '..MMMMMMM..',
  'PMMPMMMPMMP',
  'PMMPMMMPMMP',
  '..M.M.M.M..',
  '.D..D.D..D.',
]

const CRAB_MARK_COMPACT: string[] = [
  'P.P.......',
  'MMM....MM.',
  '.MMPMMPMM.',
  '.MMPMMPMM.',
  '.LLLLLLLL.',
  '.C.C..C.C.',
]

const CRAB_ART_SLEEP: string[] = [
  '.............',
  '.............',
  '.............',
  '.............',
  '.............',
  '.............',
  '..MMMMMMMMM..',
  '.MMMMMMMMMMM.',
  '.MMmMMMMMmMM.',
  '.MMMMMMMMMMM.',
  'CCMLLLLLLLMCC',
  'CC.C.C.C.C.CC',
]

const CRAB_HERO_SLEEP: string[] = [
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '......LLMMMMMMMMMm......',
  '....LLMMMMMMMMMMMMm.....',
  '...LMMmmMMMMMMmmMMMm....',
  '..mMMMMMMMMMMMMMMMMmm...',
  '.CCC.mMMMMMMMMMMm..CCC..',
  'CCCC.mMMMMMMMMMMMm.CCCC.',
  '.CC..%%%%%%%%%%%%..CC...',
  '.....DDDDDDDDDDDD.......',
  '...CC.CC.CC..CC.CC.CC...',
  '...CC.CC.CC..CC.CC.CC...',
]

const CRAB_MINI_SLEEP: string[] = [
  '...........',
  '...........',
  '..MMMMMMM..',
  '.MMmMMMmMM.',
  'CCMLLLLLMCC',
  'C.C.M.M.C.C',
]

const CRAB_SQUARE: string[] = [
  '.............',
  '.............',
  '.CC.......CC.',
  '.CCMMMMMMMCC.',
  '.MEEEMMMEEEM.',
  '.MEKEMMMEKEM.',
  '.MMMMMMMMMMM.',
  '.MMMMMMMMMMM.',
  '.MLLMMMMMLLM.',
  '.MMMMMMMMMMM.',
  '.C.C.C.C.C.C.',
  '.C.C.C.C.C.C.',
]

const CRAB_SQUARE_DOCK: string[] = [
  '.CC.....CC.',
  '.MMMMMMMMM.',
  '.MEEEMEEEM.',
  '.MEKEMEKEM.',
  '.MMMMMMMMM.',
  '.C.C.C.C.C.',
]

const CRAB: CritterDef = {
  name: 'crab',
  hue: TERRA,
  hueDeep: CLAW,
  mark: { pre: '▖', core: '▟▆▙', post: '▗' },
  art: CRAB_ART,
  heroArt: CRAB_HERO,
  mini: CRAB_MINI,
  markCompact: CRAB_MARK_COMPACT,
  square: CRAB_SQUARE,
  squareDock: CRAB_SQUARE_DOCK,
  sleep: {
    art: { art: CRAB_ART_SLEEP, flow: 0 },
    hero: { art: CRAB_HERO_SLEEP, flow: 0 },
    mini: { art: CRAB_MINI_SLEEP, flow: 0 },
  },
}

const OCTOPUS_ART: string[] = [
  '....MMMMM....',
  '..MMMMMMMMM..',
  '.MMMMMMMMMMM.',
  'MMMMMMMMMMMMM',
  'MMMPMMMMMPMMM',
  'MMMPMMMMMPMMM',
  'MMMMMMMMMMMMM',
  'MMMMMMMMMMMMM',
  'MM.MM.M.MM.MM',
  'CM.MC.M.CM.MC',
  'C..C..C..C..C',
  '.C....C....C.',
]

const OCTOPUS_HERO: string[] = [
  '.......LLMMMM...........',
  '.....LLMMMMMMMMM........',
  '....LLMMMMMMMMMMm.......',
  '...LLMMMMMMMMMMMMm......',
  '..LMMMMMMMMMMMMMMMm.....',
  '..LMMMMMMMMMMMMMMMm.....',
  '..MMMMMMMMMMMMMMMMmm....',
  '..MMMMMMMMMMMMMMMMmm....',
  '..MMEEEMMMMMMMMEEEmm....',
  '..MMEKEMMMMMMMMEKEmm....',
  '..MMMMMMMMMMMMMMMMmm.CC.',
  '...mMMMMMMMMMMMMmm...CC.',
  '...MMMMMMMMMMMMMMMM..MM.',
  '...MM.MM.MM.MM.MM....MM.',
  '..MM..MM.MM.MM..MM..MM..',
  '.CM..CM..MM.MM...MC.MM..',
  '.........MM..MC.........',
  '........CC..............',
]

const OCTOPUS_MINI: string[] = [
  '...MMMMM...',
  '..MMMMMMM..',
  '.MMPMMMPMM.',
  '.MMPMMMPMM.',
  '.M.M.M.M.M.',
  '.D..D.D..D.',
]

const OCTOPUS_MARK_COMPACT: string[] = [
  '..MMMMMM..',
  '.MMMMMMMM.',
  '.MMPMMPMM.',
  '.MMPMMPMM.',
  '.MMMMMMMM.',
  'MC.M..M.CM',
]

const OCTOPUS_ART_SLEEP: string[] = [
  '.............',
  '.............',
  '.............',
  '.............',
  '.............',
  '.............',
  '...MMMMMMM...',
  '.MMMMMMMMMMM.',
  '.MMmMMMMMmMM.',
  'MMMMMMMMMMMMM',
  '.MMMMMMMMMMM.',
  '.MC.MC.CM.CM.',
]

const OCTOPUS_HERO_SLEEP: string[] = [
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '.......LLMMMMMM.........',
  '.....LLMMMMMMMMMm.......',
  '....LMMMMMMMMMMMMm......',
  '...MMMMMMMMMMMMMMMm.....',
  '...MMmmMMMMMMMMmmMMm....',
  '..mMMMMMMMMMMMMMMMMm....',
  '..MMMMMMMMMMMMMMMMMm....',
  '..mmmmmmmmmmmmmmmmm.....',
  '.MM..MM..MM..MM..MM.....',
  '.CC..CC..CC..CC..CC.....',
]

const OCTOPUS_MINI_SLEEP: string[] = [
  '...........',
  '...........',
  '..MMMMMMM..',
  '.MMmMMMmMM.',
  '.MMMMMMMMM.',
  '.MC.MCM.CM.',
]

const OCTOPUS_SQUARE: string[] = [
  '.............',
  '.............',
  '..MMMMMMMMM..',
  '.MMMMMMMMMMM.',
  '.MEEEMMMEEEM.',
  '.MEKEMMMEKEM.',
  '.MMMMMMMMMMM.',
  '.MMMMMMMMMMM.',
  '.MMMMMMMMMMM.',
  '.MMMMMMMMMMM.',
  '.M.M.M.M.M.M.',
  '.C.C.C.C.C.C.',
]

const OCTOPUS_SQUARE_DOCK: string[] = [
  '..MMMMMMM..',
  '.MMMMMMMMM.',
  '.MEEEMEEEM.',
  '.MEKEMEKEM.',
  '.MMMMMMMMM.',
  '.M.M.M.M.M.',
]

const OCTOPUS: CritterDef = {
  name: 'octopus',
  hue: OCTOPUS_HUE,
  hueDeep: OCTOPUS_HUE_DEEP,
  mark: { pre: '▝', core: '▜▆▛', post: '▘' },
  art: OCTOPUS_ART,
  heroArt: OCTOPUS_HERO,
  mini: OCTOPUS_MINI,
  markCompact: OCTOPUS_MARK_COMPACT,
  square: OCTOPUS_SQUARE,
  squareDock: OCTOPUS_SQUARE_DOCK,
  sleep: {
    art: { art: OCTOPUS_ART_SLEEP, flow: 2 },
    hero: { art: OCTOPUS_HERO_SLEEP, flow: 2 },
    mini: { art: OCTOPUS_MINI_SLEEP, flow: 2 },
  },
  flow: { art: 2, hero: 2, mini: 2 },
}

const JELLYFISH_ART: string[] = [
  '...MMMMMMM...',
  '..MMMMMMMMM..',
  '.MMMMMMMMMMM.',
  'MMMMMMMMMMMMM',
  'MMMEMMMMMEMMM',
  'MMMPMMMMMPMMM',
  'LLLLLLLLLLLLL',
  '.M.M.M.M.M.M.',
  '.M.C.M.M.C.M.',
  '.C...M.M...C.',
  '.....C.C.....',
  '.............',
]

const JELLYFISH_HERO: string[] = [
  '.......LLMMMMM..........',
  '.....LLMMMMMMMMM........',
  '....LMMMMMMMMMMMm.......',
  '...LMMMMMMMMMMMMMm......',
  '...MMEEMMMMMMEEMMm......',
  '...MMEKMMMMMMEKMMm......',
  '...mMMMMMMMMMMMMMm......',
  '...mMMMMMMMMMMMMMm......',
  '...%%%%%%%%%%%%%%%......',
  '....M..M..M..M..M.......',
  '....M..M..M..M..M.......',
  '....M..C..M..C..M.......',
  '.....M.C..M..C.M........',
  '.....C..C.M.C..C........',
  '........C.M.............',
  '..........C.............',
  '.........C..............',
  '...........C............',
]

const JELLYFISH_MINI: string[] = [
  '..%%MMMMM..',
  '.MMMMMMMMM.',
  '.MEPMMMPEM.',
  '.MEPMMMPEM.',
  '.LLLLLLLLL.',
  '.M.C.M.C.M.',
]

const JELLYFISH_MARK_COMPACT: string[] = [
  '..%%MMMM..',
  '.MMMMMMMM.',
  '.MEPMMPEM.',
  '.MEPMMPEM.',
  '.LLLLLLLL.',
  '.M.C..C.M.',
]

const JELLYFISH_ART_SLEEP: string[] = [
  '.............',
  '.............',
  '...MMMMMMM...',
  '..MMMMMMMMM..',
  '.MMMMMMMMMMM.',
  'MMMmMMMMMmMMM',
  'MMMMMMMMMMMMM',
  'LLLLLLLLLLLLL',
  '.M.M.M.M.M.M.',
  '.M.C.M.M.C.M.',
  '.C...M.M...C.',
  '.....C.C.....',
]

const JELLYFISH_HERO_SLEEP: string[] = [
  '........................',
  '........................',
  '........................',
  '........................',
  '.......LLMMMMM..........',
  '.....LLMMMMMMMMM........',
  '....LMMMMMMMMMMMm.......',
  '...LMMMMMMMMMMMMMm......',
  '...MMmmMMMMMMmmMMm......',
  '...mMMMMMMMMMMMMMm......',
  '...%%%%%%%%%%%%%%%......',
  '....M..M..M..M..M.......',
  '....M..M..M..M..M.......',
  '.....M....M....M........',
  '.....M....M....M........',
  '.....C....M....C........',
  '..........M.............',
  '..........C.............',
]

const JELLYFISH_MINI_SLEEP: string[] = [
  '...........',
  '...........',
  '..MMMMMMM..',
  '.MEPMMMPEM.',
  '.LLLLLLLLL.',
  '.M.C.M.C.M.',
]

const JELLYFISH_SQUARE: string[] = [
  '.............',
  '.............',
  '..MMMMMMMMM..',
  '.MMMMMMMMMMM.',
  '.MMMMMMMMMMM.',
  '.MMMMMMMMMMM.',
  '.MEEEMMMEEEM.',
  '.MEKEMMMEKEM.',
  '.%%%%%%%%%%%.',
  '.%%%%%%%%%%%.',
  '.M.C.M.M.C.M.',
  '.M.C.M.M.C.M.',
]

const JELLYFISH_SQUARE_DOCK: string[] = [
  '..MMMMMMM..',
  '.MMMMMMMMM.',
  '.MEEEMEEEM.',
  '.MEKEMEKEM.',
  '.%%%%%%%%%.',
  '.M.C.M.C.M.',
]

const JELLYFISH: CritterDef = {
  name: 'jellyfish',
  hue: JELLYFISH_HUE,
  hueDeep: JELLYFISH_HUE_DEEP,
  mark: { pre: '▚', core: '▛▀▜', post: '▞' },
  art: JELLYFISH_ART,
  heroArt: JELLYFISH_HERO,
  mini: JELLYFISH_MINI,
  markCompact: JELLYFISH_MARK_COMPACT,
  square: JELLYFISH_SQUARE,
  squareDock: JELLYFISH_SQUARE_DOCK,
  sleep: {
    art: { art: JELLYFISH_ART_SLEEP, flow: 4 },
    hero: { art: JELLYFISH_HERO_SLEEP, flow: 2 },
    mini: { art: JELLYFISH_MINI_SLEEP, flow: 2 },
  },
  flow: { art: 4, hero: 8, mini: 2 },
}

const CLAM_ART: string[] = [
  '....LLCLL....',
  '.mMMMCMCMMMm.',
  '.MDMMDMDMMDM.',
  '..DDDDDDDDD..',
  '..DPPDDDPPD..',
  '..DPPDDDPPD..',
  '.%%%%%%%%%%%.',
  '.MCMMCMCMMCM.',
  '..MCMMCMMCM..',
  '...CCCCCCC...',
]

const CLAM_HERO: string[] = [
  '.........LLCCLL.........',
  '.......LLMMCCMMLL.......',
  '....mMMMCMMCCMMCMMMm....',
  '..mMMMCMMMCMMCMMMCMMMm..',
  '..MDMMDMMMDMMDMMMDMMDM..',
  '...DDDDDDDDDDDDDDDDDD...',
  '...DDDEEEDDDDDDEEEDDD...',
  '...DDDEKEDDDDDDEKEDDD...',
  '..%%%%%%%%%%%%%%%%%%%%..',
  '..mMCMMMCMMMMMMCMMMCMm..',
  '..mMMCMMMCMMMMCMMMCMMm..',
  '...mMMCMMMCMMCMMMCMMm...',
  '....mMMCMMMCCMMMCMMm....',
  '.....CCCCCCCCCCCCCC.....',
]

const CLAM_MINI: string[] = [
  '..LLMCMLL..',
  '.mMMCMCMMm.',
  '.DPPDDDPPD.',
  '.DPPDDDPPD.',
  '.%%%%%%%%%.',
  '.MCMMMMMCM.',
]

const CLAM_MARK_COMPACT: string[] = [
  '..LMCCML..',
  '.mMMCCMMm.',
  '.DPPDDPPD.',
  '.DPPDDPPD.',
  '.%%%%%%%%.',
  '.MCMMMMCM.',
]

const CLAM_ART_SLEEP: string[] = [
  '.............',
  '.............',
  '....LLCLL....',
  '.mMMMCMCMMMm.',
  '.MMmmCMCmmMM.',
  '.DDDDDDDDDDD.',
  '.MCMMCMCMMCM.',
  '..MCMMCMMCM..',
  '...mMMCMMm...',
  '...CCCCCCC...',
]

const CLAM_HERO_SLEEP: string[] = [
  '........................',
  '........................',
  '........................',
  '........................',
  '.........LLCCLL.........',
  '.......LLMMCCMMLL.......',
  '....mMMMCMMCCMMCMMMm....',
  '..mMMMCMMMCMMCMMMCMMMm..',
  '..MMMMmmmCMMMMCmmmMMMM..',
  '..DDDDDDDDDDDDDDDDDDDD..',
  '..mMCMMMCMMMMMMCMMMCMm..',
  '..mMMCMMMCMMMMCMMMCMMm..',
  '....mMMCMMMCCMMMCMMm....',
  '.....CCCCCCCCCCCCCC.....',
]

const CLAM_MINI_SLEEP: string[] = [
  '...........',
  '...........',
  '..LLMCMLL..',
  '.MmmMCMmmM.',
  '.DDDDDDDDD.',
  '.MCMMMMMCM.',
]

const CLAM_SQUARE: string[] = [
  '.............',
  '.............',
  '.MMMMMCMMMMM.',
  '.MDMMDCDMMDM.',
  '.DEEEDDDEEED.',
  '.DEKEDDDEKED.',
  '.%%%%%%%%%%%.',
  '.%%%%%%%%%%%.',
  '.MCMMMCMMMCM.',
  '.MCMMMCMMMCM.',
  '.CCCCCCCCCCC.',
  '.CCCCCCCCCCC.',
]

const CLAM_SQUARE_DOCK: string[] = [
  '.MMMMCMMMM.',
  '.DDDDDDDDD.',
  '.DEEEDEEED.',
  '.DEKEDEKED.',
  '.%%%%%%%%%.',
  '.CCCCCCCCC.',
]

const CLAM: CritterDef = {
  name: 'clam',
  hue: CLAM_HUE,
  hueDeep: CLAM_HUE_DEEP,
  mark: { pre: '▗', core: '▙█▟', post: '▖' },
  art: CLAM_ART,
  heroArt: CLAM_HERO,
  mini: CLAM_MINI,
  markCompact: CLAM_MARK_COMPACT,
  square: CLAM_SQUARE,
  squareDock: CLAM_SQUARE_DOCK,
  sleep: {
    art: { art: CLAM_ART_SLEEP, flow: 0 },
    hero: { art: CLAM_HERO_SLEEP, flow: 0 },
    mini: { art: CLAM_MINI_SLEEP, flow: 0 },
  },
  settle: { art: 3, hero: 5, mini: 1 },
  sleepGlyphs: CLAM_SLEEP_GLYPHS,
}


export const CRITTERS: CritterDef[] = [CRAB, OCTOPUS, JELLYFISH, CLAM]

export const CRITTER_COUNT = CRITTERS.length

export function critterAt(i: number): CritterDef {
  return CRITTERS[((i % CRITTERS.length) + CRITTERS.length) % CRITTERS.length]!
}

export type CritterState = 'thinking' | 'working' | 'blocked' | 'done' | 'sleeping' | 'idle'

export const DEFAULT_CRITTER_KEY = 'jellyfish'

const BY_KEY: Record<string, CritterDef> = Object.fromEntries(CRITTERS.map(d => [d.name, d]))

export const LEGACY_CRITTER_KEYS: Readonly<Record<string, string>> = {
  mantis: 'clam',
  'mantis shrimp': 'clam',
}

function resolvePoolKey(key: string | undefined | null): string {
  const k = (key ?? '').trim().toLowerCase()
  if (Object.hasOwn(BY_KEY, k)) return k
  const legacy = LEGACY_CRITTER_KEYS[k]
  if (legacy !== undefined && Object.hasOwn(BY_KEY, legacy)) return legacy
  return DEFAULT_CRITTER_KEY
}

export function critterDefForKey(key: string | undefined | null): CritterDef {
  return BY_KEY[resolvePoolKey(key)]!
}

export function isPoolCritterKey(key: string | undefined | null): boolean {
  return Object.hasOwn(BY_KEY, (key ?? '').trim().toLowerCase())
}

export function miniArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.mini
}

export function markCompactArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.markCompact.slice()
}

export function squareArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.square
}

export function squareDockArtFor(key: string | undefined | null): string[] {
  return BY_KEY[resolvePoolKey(key)]!.squareDock
}

export function sleepPoseFor(def: Pick<CritterDef, 'name'>, form: ArtForm): SleepPose | null {
  return BY_KEY[def.name]?.sleep[form] ?? null
}


const BOUNDS_BY_GRID = new WeakMap<readonly string[], [number, number]>()

export function heroContentBounds(art: string[]): [number, number] {
  const known = BOUNDS_BY_GRID.get(art)
  if (known !== undefined) return known
  let start = Number.MAX_SAFE_INTEGER
  let end = 0
  for (const row of art) {
    for (let i = 0; i < row.length; i++) {
      if (row[i] !== '.') {
        if (i < start) start = i
        if (i + 1 > end) end = i + 1
      }
    }
  }
  const bounds: [number, number] = start >= end ? [0, Math.max(...art.map(r => r.length), 0)] : [start, end]
  BOUNDS_BY_GRID.set(art, bounds)
  return bounds
}

export const HERO_ART_LINES: number = CRITTERS.reduce(
  (max, def) => Math.max(max, Math.ceil((def.heroArt?.length ?? 0) / 2)),
  0,
)

export const FLAT_ART_LINES: number = CRITTERS.reduce(
  (max, def) => Math.max(max, Math.ceil(def.art.length / 2)),
  0,
)

export const SQUARE_ART_LINES: number = CRITTERS.reduce(
  (max, def) => Math.max(max, Math.ceil(def.square.length / 2)),
  0,
)

export type CritterForm = 'hero' | 'premium-compact' | 'mini' | 'none'

export const PREMIUM_COMPACT_MIN_ROWS = 24

export const BERTH_HERO_MIN_ROWS: number = 28 + (HERO_ART_LINES - FLAT_ART_LINES)

export function decideCritterForm(
  allocated: { columns: number; rows: number },
  hasHeroArt: boolean,
): CritterForm {
  const { columns, rows } = allocated
  if (columns < CR_COLS + 2) return 'none'
  if (!hasHeroArt || columns < HERO_ART_COLS + 4) return 'mini'
  return rows >= BERTH_HERO_MIN_ROWS ? 'hero' : 'mini'
}


export function heroBlinkRows(art: string[]): string[] {
  return art.map((row, i) =>
    row.includes('K') || (art[i ^ 1]?.includes('K') ?? false)
      ? row.replace(/[EK]/g, 'm')
      : row,
  )
}


const SWAY_OFFSETS: readonly number[] = [0, 0, 1, 1, 0, 0, -1, -1]
export const SWAY_PHASES = SWAY_OFFSETS.length


function shiftRowLossless(row: string, off: number): string {
  if (off === 0) return row
  const n = Math.abs(off)
  const edge = off > 0 ? row.slice(row.length - n) : row.slice(0, n)
  if (/[^.]/.test(edge)) return row
  return off > 0
    ? '.'.repeat(n) + row.slice(0, row.length - n)
    : row.slice(n) + '.'.repeat(n)
}

export function swayRows(art: string[], depth: number, phase: number): string[] {
  if (depth <= 0 || art.length === 0) return art.slice()
  const first = Math.max(0, art.length - depth)
  const firstLine = Math.floor(first / 2)
  return art.map((row, i) => {
    if (i < first) return row
    const lag = Math.floor(i / 2) - firstLine
    const off = SWAY_OFFSETS[(((phase - lag) % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES]!
    return shiftRowLossless(row, off)
  })
}

export function flowDepthFor(def: CritterDef, form: ArtForm): number {
  return def.flow?.[form] ?? 0
}


export function settleDepthFor(def: CritterDef, form: ArtForm): number {
  return def.settle?.[form] ?? 0
}

const SETTLE_PHASE = SWAY_OFFSETS.findIndex(off => off > 0)

export function settleRows(art: string[], depth: number, phase: number): string[] {
  if (depth <= 0 || depth >= art.length) return art.slice()
  const off = SWAY_OFFSETS[((phase % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES]!
  if (off <= 0) return art.slice()
  return art.map((row, i) => {
    if (i === 0) return '.'.repeat(row.length)
    if (i > depth) return row
    const from = art[i - 1]!
    return from.length === row.length ? from : (from + '.'.repeat(row.length)).slice(0, row.length)
  })
}

export function effectiveSwayPhase(def: CritterDef, form: ArtForm, asleep: boolean, phase: number): number {
  const p = ((phase % SWAY_PHASES) + SWAY_PHASES) % SWAY_PHASES
  if (asleep) {
    const pose = sleepPoseFor(def, form)
    if (pose !== null) {
      return pose.flow > 0 ? p : p % SLEEP_BREATH_FRAMES
    }
  }
  if (flowDepthFor(def, form) > 0) return p
  if (settleDepthFor(def, form) > 0) return SWAY_OFFSETS[p]! > 0 ? SETTLE_PHASE : 0
  return 0
}


export function sleepZzzSlots(art: string[], count: number = SLEEP_PHASES): number[] {
  const top = art[0]
  const bot = art[1]
  if (top === undefined || bot === undefined) return []
  const width = Math.max(top.length, bot.length)
  const free = (c: number): boolean => (top[c] ?? '.') === '.' && (bot[c] ?? '.') === '.'
  let end = -1
  for (let c = width - 1; c >= 0; c--) {
    if (free(c)) {
      end = c
      break
    }
  }
  if (end < 0) return []
  const slots: number[] = []
  for (let c = end; c >= 0 && free(c) && slots.length < count; c--) slots.push(c)
  return slots.reverse()
}

export function sleepZzzArt(art: string[], phase: number, count: number = SLEEP_PHASES): string[] {
  const slots = sleepZzzSlots(art, count)
  if (slots.length === 0) return art.slice()
  const p = ((phase % SLEEP_PHASES) + SLEEP_PHASES) % SLEEP_PHASES
  const lit = new Set<number>()
  const n = slots.length
  const litCount = Math.min(n, Math.max(p + 1, n - (SLEEP_PHASES - 1 - p)))
  for (const c of slots.slice(n - litCount)) lit.add(c)
  const paint = (row: string): string =>
    row
      .split('')
      .map((ch, c) => (lit.has(c) ? SLEEP_CELL : ch))
      .join('')
  return art.map((row, i) => (i < 2 ? paint(row) : row))
}

export const SLEEP_BREATH_FRAMES = 2

export function sleepBreathArt(art: string[], frame: number): string[] {
  if (((frame % SLEEP_BREATH_FRAMES) + SLEEP_BREATH_FRAMES) % SLEEP_BREATH_FRAMES === 0) {
    return art.slice()
  }
  const crown = art.findIndex(r => /[^.]/.test(r))
  if (crown < 0) return art.slice()
  const below = art[crown + 1] ?? ''
  const dipped = art[crown]!
    .split('')
    .map((ch, c) => (ch !== '.' && (below[c] ?? '.') !== '.' ? '.' : ch))
    .join('')
  return art.map((row, i) => (i === crown ? dipped : row))
}
