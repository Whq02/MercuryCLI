#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'motion-setting-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.MERCURY_CRITTER_IDLE
delete process.env.MERCURY_LIVE_GLYPHS

const ROOT = join(import.meta.dir, '..', '..')
const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.js')
const {
  MOTION_DOORS,
  MOTION_MENU_ROW,
  MOTION_SETTINGS,
  isMotionSetting,
  motionDetailLines,
  motionReceiptWords,
  motionValueWords,
  noteMotionSettingChanged,
  primeMotionSetting,
  readMotionSetting,
  setMotionSetting,
} = await import('../../src/utils/cockpit/motionSetting.js')
const {
  __motionGovernorResetForTest,
  __setLoopMeterForTest,
  clockPeriodMs,
  FRAME_BUDGET_MS,
  idleMotionLevel,
  idleMotionWord,
  motionPosture,
  noteFrameCost,
  REDUCED_FLOOR_MS,
  TRIP_RUN,
} = await import('../../src/utils/cockpit/motionGovernor.js')
const { critterIdleTickMs, IDLE_TICK_MS } = await import('../../src/utils/cockpit/critterIdle.js')
const { glyphTickMs, REDUCED_TICK_MS, WORK_TICK_MS } = await import('../../src/utils/cockpit/liveGlyphs.js')
const { STARTUP_MENU } = await import('../../src/substrate/startupMenu.js')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
const { generateSettingsJSONSchema } = await import('../../src/utils/settings/schemaOutput.js')
const { STILLS, readStill, renderStill, stillPath, composeMotionMenu } = await import('../ui/motion-menu-stills.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const configPath = join(HOME, '.mercury.json')
const storedMotion = (): unknown => {
  if (!existsSync(configPath)) return undefined
  return (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>).motion
}

console.log('============================================================')
console.log(' motion setting — one key · two doors · the cadence each value names')
console.log('============================================================')
enableConfigs()
__setLoopMeterForTest({ begin() {}, busyShare: () => 1 })

section('S1 the key')
check('a fresh home reads auto', readMotionSetting() === 'auto')
check('…and pushes the auto posture', motionPosture() === 'auto')
check('the closed vocabulary', MOTION_SETTINGS.join(',') === 'auto,full,reduced,off' && isMotionSetting('reduced') && !isMotionSetting('fast'))
setMotionSetting('reduced')
check('a stored value lands in the config file', storedMotion() === 'reduced', String(storedMotion()))
check('…reads back through the owner', readMotionSetting() === 'reduced' && getGlobalConfig().motion === 'reduced')
check('…and pushed the posture', motionPosture() === 'reduced')
setMotionSetting('auto')
check('auto deletes the key (absent = auto)', storedMotion() === undefined && readMotionSetting() === 'auto')
{
  saveGlobalConfig(c => ({ ...c, motion: 'fast' as never }))
  noteMotionSettingChanged()
  const read = readMotionSetting()
  const bytes = storedMotion()
  check('an unknown stored spelling reads as auto, the bytes untouched', read === 'auto' && bytes === 'fast', `${read} / ${String(bytes)}`)
  saveGlobalConfig(c => {
    const out = { ...c }
    delete out.motion
    return out
  })
  noteMotionSettingChanged()
}
primeMotionSetting()
check('priming after a read is a no-op (the posture stands)', motionPosture() === 'auto')

section('S2 the cadences each value names')
const cadence = (): string =>
  `critter=${critterIdleTickMs(idleMotionLevel('critter'), false)} glyph=${glyphTickMs(idleMotionLevel('glyphs'), WORK_TICK_MS)} clock=${clockPeriodMs(16)}`
__motionGovernorResetForTest()
setMotionSetting('full')
check('full: the critter at its tick, the glyphs at theirs, the clock at 16', cadence() === `critter=${IDLE_TICK_MS} glyph=${WORK_TICK_MS} clock=16`, cadence())
for (let i = 0; i < TRIP_RUN; i++) noteFrameCost(FRAME_BUDGET_MS + 40)
check('full never reduces: the governor tripped, the cadence stands', cadence() === `critter=${IDLE_TICK_MS} glyph=${WORK_TICK_MS} clock=16` && idleMotionWord() === null, cadence())
__motionGovernorResetForTest()
setMotionSetting('reduced')
check('reduced: the critter paused, the glyphs at the slow tick, the clock at the floor', cadence() === `critter=null glyph=${REDUCED_TICK_MS} clock=${REDUCED_FLOOR_MS}`, cadence())
check('reduced: the status word shows', idleMotionWord() === 'reduced')
setMotionSetting('off')
check('off: no idle tick anywhere', cadence() === 'critter=null glyph=null clock=16' && idleMotionLevel('clock') === 'off', cadence())
check('off: no status word', idleMotionWord() === null)
setMotionSetting('auto')
__motionGovernorResetForTest()
check('auto: full until the governor says otherwise', cadence() === `critter=${IDLE_TICK_MS} glyph=${WORK_TICK_MS} clock=16`, cadence())
for (let i = 0; i < TRIP_RUN; i++) noteFrameCost(FRAME_BUDGET_MS + 40)
check('auto: reduced once the governor trips', cadence() === `critter=null glyph=${REDUCED_TICK_MS} clock=${REDUCED_FLOOR_MS}`, cadence())
__motionGovernorResetForTest()

section('S3 the env switches under a saved value')
setMotionSetting('full')
process.env.MERCURY_CRITTER_IDLE = '0'
check('MERCURY_CRITTER_IDLE=0 with full saved: the critter part off, the glyph part full', idleMotionLevel('critter') === 'off' && idleMotionLevel('glyphs') === 'full')
delete process.env.MERCURY_CRITTER_IDLE
process.env.MERCURY_LIVE_GLYPHS = '0'
check('MERCURY_LIVE_GLYPHS=0 with full saved: the glyph part off, the critter part full', idleMotionLevel('glyphs') === 'off' && idleMotionLevel('critter') === 'full')
process.env.MERCURY_CRITTER_IDLE = '0'
setMotionSetting('reduced')
check('both switches with reduced saved: the whole choice off', idleMotionLevel('clock') === 'off' && idleMotionWord() === null)
check('the value column still names the saved value', motionValueWords() === 'reduced')
check('the detail names the switch holding each part off', motionDetailLines().some(l => l.startsWith('MERCURY_CRITTER_IDLE=0')) && motionDetailLines().some(l => l.startsWith('MERCURY_LIVE_GLYPHS=0')))
delete process.env.MERCURY_CRITTER_IDLE
delete process.env.MERCURY_LIVE_GLYPHS
setMotionSetting('auto')
__motionGovernorResetForTest()

section("S4 the doors' words")
check('the value column under auto names the level running now', motionValueWords('auto') === 'auto · full')
for (let i = 0; i < TRIP_RUN; i++) noteFrameCost(FRAME_BUDGET_MS + 40)
check('…and follows the governor', motionValueWords('auto') === 'auto · reduced')
__motionGovernorResetForTest()
check('a set value is its own word', motionValueWords('reduced') === 'reduced' && motionValueWords('off') === 'off')
check('the receipt names the value and that it applies now', motionReceiptWords('full') === 'motion full · set by you — applies now')
check('the receipt for auto says the machine decides again', motionReceiptWords('auto') === 'motion follows the machine again (auto · full) — applies now')
{
  const lines = motionDetailLines()
  check('the detail names the level now and the reduced cadence', lines[0] === 'now: full (auto — the governor says full)' && lines[1] === 'reduced cadence: 250 ms a tick (250 ms floor)', lines.join(' | '))
  check('the detail names the doors and the word', lines.includes('doors: /config · Boot Menu') && lines.includes('the status line says reduced while reduced'))
  check('the doors are spelled once', /\/config/.test(MOTION_DOORS) && /Boot Menu/.test(MOTION_DOORS))
}
{
  const config = src('src/components/Settings/Config.tsx')
  const boot = src('src/components/BootSettingsScreen.tsx')
  check('the /config door reads and writes through the owner', /readMotionSetting\(\)/.test(config) && /setMotionSetting\(next\)/.test(config) && /motionValueWords\(/.test(config))
  check('the Boot Menu door reads and writes through the owner', /readMotionSetting\(\)/.test(boot) && /setMotionSetting\(next\)/.test(boot) && /motionValueWords\(motionSetting\)/.test(boot) && /motionDetailLines\(\)/.test(boot))
  check('the /config esc-revert tells the owner when it restored the key', /noteMotionSettingChanged\(\)/.test(config))
  const owner = src('src/utils/cockpit/motionSetting.ts')
  check('the owner is the one writer of the key (saveGlobalConfig with motion)', /out\.motion = next/.test(owner))
  const schema = src('src/utils/config/schema.ts')
  check("the key is declared beside the config's other feature-owned keys", /motion\?: 'auto' \| 'full' \| 'reduced' \| 'off'/.test(schema))
}

section('S5 the menu row')
check('the row sits in the Performance section', MOTION_MENU_ROW.group === 'performance' && MOTION_MENU_ROW.label === 'Motion')
check('the row is an enum over the three set values, auto the default', MOTION_MENU_ROW.kind === 'enum' && MOTION_MENU_ROW.options.join(',') === 'full,reduced,off' && MOTION_MENU_ROW.defaultLabel === 'auto')
check('the row applies live', MOTION_MENU_ROW.applicationClass === 'live')
check('the row is config-backed: not an env row of the startup menu', STARTUP_MENU.every(r => r.env !== MOTION_MENU_ROW.env))
check('…and not a flag', FLAG_REGISTRY.every(f => f.env !== MOTION_MENU_ROW.env))
check('the Boot Menu lists it after the Seats row', /SEATS_MENU_ROW as MenuRow, MOTION_MENU_ROW as MenuRow\]/.test(src('src/components/BootSettingsScreen.tsx')))

section('S6 the stills')
for (const still of STILLS) {
  const live = renderStill(still.compose())
  const written = readStill(still.id)
  if (written === null) {
    check(`${still.id}: fixture present (bun scripts/ui/motion-menu-stills.ts --write)`, false, stillPath(still.id))
    continue
  }
  check(`${still.id}: the live composition byte-matches the written still`, live === written, 'regenerate on purpose: bun scripts/ui/motion-menu-stills.ts --write')
}
{
  const wide = composeMotionMenu(120, 40).join('\n')
  check('wide: the PERFORMANCE header and the Motion row with its value', /PERFORMANCE/.test(wide) && /❯ Motion\s+auto · full/.test(wide), wide.split('\n').filter(l => /Motion|PERFORMANCE/.test(l)).join(' | '))
  check('wide: the detail pane names the value and the level now', /Current value/.test(wide) && /auto · full/.test(wide) && /now: full \(auto/.test(wide))
  const tall = composeMotionMenu(160, 48).join('\n')
  check('tall: the detail pane names the doors and the word', /doors: \/config · Boot Menu/.test(tall) && /the status line says reduced while reduced/.test(tall), tall.split('\n').filter(l => /doors|status line|trail/.test(l)).join(' | '))
  const classic = composeMotionMenu(100, 34).join('\n')
  check('classic: the performance header and the Motion row', /performance/.test(classic) && /❯ Motion\s+auto · full/.test(classic), classic.split('\n').filter(l => /Motion|performance/.test(l)).join(' | '))
  const reduced = composeMotionMenu(120, 40, 'reduced').join('\n')
  check('wide, reduced saved: the row reads reduced and the detail says set by you', /❯ Motion\s+reduced/.test(reduced) && /now: reduced \(set by you\)/.test(reduced))
}

section('S7 the documents')
{
  const profile = src('docs/TERMINAL-PROFILE.md')
  check('the terminal profile names the setting, its four values and both doors', /## Motion/.test(profile) && /`auto`/.test(profile) && /`off`/.test(profile) && /Motion row of `\/config`/.test(profile) && /Performance section/.test(profile))
  check('the terminal profile maps the two switches onto the choice', /MERCURY_CRITTER_IDLE=0`\s+holds the critter part off/.test(profile.replace(/\n/g, ' ')) && /MERCURY_LIVE_GLYPHS=0`\s+the glyph part/.test(profile.replace(/\n/g, ' ')))
  const readme = src('README.md')
  check('the README names the Performance section and the /config row', /Performance section holds the Motion/.test(readme))
  const schema = generateSettingsJSONSchema()
  check('the settings schema snapshot carries no such key (the global config owns it)', !/"motion"/.test(schema))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ motion setting GREEN' : `❌ motion setting RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
