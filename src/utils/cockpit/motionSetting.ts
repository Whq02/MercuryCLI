import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../config.js'
import { critterIdleEnabled } from './critterIdle.js'
import { liveGlyphsEnabled } from './liveGlyphs.js'
import {
  idleMotionLevel,
  motionGovernorFacts,
  motionPosture,
  REDUCED_FLOOR_MS,
  setMotionPosture,
} from './motionGovernor.js'
//  global config (the `motion` key; absent = auto). Reading it pushes the

export const MOTION_SETTINGS = ['auto', 'full', 'reduced', 'off'] as const
export type MotionSetting = (typeof MOTION_SETTINGS)[number]

export function isMotionSetting(value: unknown): value is MotionSetting {
  return typeof value === 'string' && (MOTION_SETTINGS as readonly string[]).includes(value)
}

let primed = false

export function readMotionSetting(options: { quiet?: boolean } = {}): MotionSetting {
  if (!isConfigReadingAllowed()) return motionPosture()
  const raw = getGlobalConfig().motion
  const setting = isMotionSetting(raw) ? raw : 'auto'
  setMotionPosture(setting, options)
  primed = true
  return setting
}

export function primeMotionSetting(): void {
  if (primed) return
  readMotionSetting({ quiet: true })
}

export function setMotionSetting(next: MotionSetting): MotionSetting {
  saveGlobalConfig(config => {
    const out = { ...config }
    if (next === 'auto') delete out.motion
    else out.motion = next
    return out
  })
  setMotionPosture(next)
  primed = true
  return next
}

export function noteMotionSettingChanged(): void {
  readMotionSetting()
}

export const MOTION_DOORS = 'the Motion row of /config, or the Motion row of the Boot Menu (one setting)'

export function motionValueWords(setting: MotionSetting = readMotionSetting()): string {
  if (setting !== 'auto') return setting
  return `auto · ${idleMotionLevel('clock')}`
}

export function motionReceiptWords(setting: MotionSetting): string {
  if (setting === 'auto') return `motion follows the machine again (${motionValueWords('auto')}) — applies now`
  return `motion ${setting} · set by you — applies now`
}

export function motionDetailLines(): string[] {
  const facts = motionGovernorFacts()
  const lines = [
    `now: ${facts.effective}${facts.posture === 'auto' ? ` (auto — the governor says ${facts.level})` : ' (set by you)'}`,
    `reduced cadence: ${facts.reducedPeriodMs} ms a tick (${REDUCED_FLOOR_MS} ms floor)`,
  ]
  if (!critterIdleEnabled()) lines.push('MERCURY_CRITTER_IDLE=0 holds the critter part off')
  if (!liveGlyphsEnabled()) lines.push('MERCURY_LIVE_GLYPHS=0 holds the glyph part off')
  lines.push('doors: /config · Boot Menu', 'the status line says reduced while reduced')
  return lines
}

export const MOTION_MENU_ROW = {
  env: 'motion',
  label: 'Motion',
  group: 'performance',
  kind: 'enum',
  options: ['full', 'reduced', 'off'],
  defaultLabel: 'auto',
  applicationClass: 'live',
  summary:
    'how much idle motion the cockpit runs — auto follows the machine (full until painting falls behind, then reduced); full never reduces; reduced slows the shared clock and stills the critter; off stops idle motion',
  detail: {
    controls: "The cockpit's idle motion — the mascot's blink and breath, the live glyphs, and the clock that paces them. Applies now.",
    on: [
      'full — every idle animation at its own cadence, whatever a frame costs',
      'reduced — the clock at the slow cadence, the mascot still, the glyphs turning slowly; the status line says reduced',
      'off — no idle motion: the mascot still, the glyphs static, the clock ticking only for work in flight',
    ],
    off: [
      'auto: full motion until a run of frames costs more than the frame budget with the event loop busy, then reduced — the clock at a quarter-second floor, slower while a frame costs more than its interval — then full again after a longer run of cheap frames',
      'MERCURY_CRITTER_IDLE=0 and MERCURY_LIVE_GLYPHS=0 read as this choice with their part off',
    ],
  },
} as const
