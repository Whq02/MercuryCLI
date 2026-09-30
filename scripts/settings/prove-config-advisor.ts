#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-advisor')
process.env.HOME = HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_ADVISOR_MODEL
const frameDir = ((): string | undefined => {
  const index = process.argv.indexOf('--frames')
  return index < 0 ? undefined : process.argv[index + 1]
})()
if (frameDir) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
async function finish(): Promise<never> {
  await releaseScratchHome(HOME)
  console.log(`\nprove-config-advisor: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

section('§0 the rows module exists (red on the base: the component and the service are absent)')
const mods = await (async () => {
  try {
    return { page: await import('../../src/components/Settings/Advisor.js'), service: await import('../../src/services/advisor/index.js') }
  } catch (error) {
    check('src/components/Settings/Advisor.tsx and src/services/advisor import', false, error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error))
    return undefined
  }
})()
const ready = mods ?? (await finish())
check('the rows and the service import', true)
const { ADVISOR_ROW_IDS, advisorConfigItems, advisorCrewmatesValueWords, nextAdvisorInterval } = ready.page
const { readAdvisorSettings } = ready.service

section('§1 the pure rows and the ladder (minutes, not turns)')
{
  const tokens = { success: 'green', textSecondary: 'grey' }
  const off = advisorConfigItems({ tokens, settings: { enabled: false, crewmates: false, minutes: 10 }, onToggle: () => {}, onCrewmates: () => {}, onInterval: () => {} })
  check('three rows: Advisor, a separate crewmate opt-in, and Advisor interval', off.length === 3 && off[0]!.id === 'advisor' && off[0]!.kind === 'boolean' && off[1]!.id === 'advisorCrewmates' && off[1]!.kind === 'boolean' && off[2]!.id === 'advisorInterval' && off[2]!.kind === 'enum' && ADVISOR_ROW_IDS.length === 3, JSON.stringify(off.map(r => [r.id, r.kind])))
  check('the crewmate warning names the separate opt-in, both switches and workflow exclusion', (off[1]!.warning ?? '').includes('both this switch and Advisor must be on') && (off[1]!.warning ?? '').includes('workflow agents never receive advice'), off[1]!.warning)
  check("the Advisor row's note says whom the note is for, how often in minutes, and where the model is picked", (off[0]!.warning ?? '').includes('addressed to the agent, never to you') && (off[0]!.warning ?? '').includes('/submodels') && (off[0]!.warning ?? '').includes('every 10 minutes') && !(off[0]!.warning ?? '').includes('turns'), off[0]!.warning)
  check('the crewmate row says "may result in high spend" whenever its switch is on, and never when it is off', advisorCrewmatesValueWords({ enabled: true, crewmates: true }) === 'on · may result in high spend' && advisorCrewmatesValueWords({ enabled: false, crewmates: true }).startsWith('on · Advisor is off') && advisorCrewmatesValueWords({ enabled: false, crewmates: true }).endsWith('may result in high spend') && advisorCrewmatesValueWords({ enabled: true, crewmates: false }) === 'off', [advisorCrewmatesValueWords({ enabled: true, crewmates: true }), advisorCrewmatesValueWords({ enabled: false, crewmates: true }), advisorCrewmatesValueWords({ enabled: true, crewmates: false })].join(' | '))
  check('the interval row says how many minutes pass between notes and lists the ladder 10 · 20 · 30 · 45 · 60 (red on the base: turns, 5 · 10 · 20 · 50)', (off[2]!.warning ?? '').startsWith('how many minutes pass between notes · 10 · 20 · 30 · 45 · 60') && !(off[2]!.warning ?? '').includes('turns'), off[2]!.warning)
  check('the ladder steps 10→20→30→45→60 and clamps at both ends', nextAdvisorInterval(10, 1) === 20 && nextAdvisorInterval(20, 1) === 30 && nextAdvisorInterval(30, 1) === 45 && nextAdvisorInterval(45, 1) === 60 && nextAdvisorInterval(60, 1) === 60 && nextAdvisorInterval(10, -1) === 10 && nextAdvisorInterval(60, -1) === 45 && nextAdvisorInterval(30, -1) === 20)
  check('an off-ladder value (a hand-edited 7 or 25) steps to its neighbours', nextAdvisorInterval(7, 1) === 10 && nextAdvisorInterval(7, -1) === 10 && nextAdvisorInterval(25, 1) === 30 && nextAdvisorInterval(25, -1) === 20 && nextAdvisorInterval(99, -1) === 60 && nextAdvisorInterval(2, -1) === 10)
  const toggles: unknown[] = []
  const on = advisorConfigItems({ tokens, settings: { enabled: false, crewmates: false, minutes: 10 }, onToggle: (next, words) => toggles.push([next, words]), onCrewmates: () => {}, onInterval: () => {} })
  on[0]!.change!(1)
  check('toggling the boolean asks the owner to write on, with the receipt words in minutes', JSON.stringify(toggles) === JSON.stringify([[true, 'set the advisor to on · every 10 minutes']]), JSON.stringify(toggles))
  const intervals: unknown[] = []
  const crewToggles: unknown[] = []
  const interval = advisorConfigItems({ tokens, settings: { enabled: true, crewmates: false, minutes: 20 }, onToggle: () => {}, onCrewmates: (next, words) => crewToggles.push([next, words]), onInterval: (next, words) => intervals.push([next, words]) })
  interval[1]!.change!(1)
  check('the crewmate row requests its own explicit opt-in, not a master toggle', JSON.stringify(crewToggles) === JSON.stringify([[true, 'set the advisor for crewmates to on']]), JSON.stringify(crewToggles))
  interval[2]!.change!(1)
  interval[2]!.change!(-1)
  check('→ and ← on the interval ask the owner for the next rung with the minutes words', JSON.stringify(intervals) === JSON.stringify([[30, 'set the advisor interval to every 30 minutes'], [10, 'set the advisor interval to every 10 minutes']]), JSON.stringify(intervals))
  const floor = advisorConfigItems({ tokens, settings: { enabled: true, crewmates: false, minutes: 10 }, onToggle: () => {}, onCrewmates: () => {}, onInterval: (next, words) => intervals.push([next, words]) })
  floor[2]!.change!(-1)
  check('← at the bottom rung asks for nothing', intervals.length === 2)
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { getGlobalConfig } = await import('../../src/utils/config.js')

async function mount(columns: number, rows: number): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: rows }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, columns, rows)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT.slice(-20)), 4000)
  await settle(150)
  return m
}
const save = (name: string, m: Mounted): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), m.lines().join('\n') + '\n')
}
const rowOf = (m: Mounted, label: string): string => m.lines().find(line => line.includes(`  ${label}`) || line.includes(`${CONFIG_ROW_MARK} ${label}`)) ?? ''
const flatScreen = (m: Mounted): string => m.lines().map(line => line.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim()).filter(line => line !== '').join(' ')
const selectedLabel = (m: Mounted): string => ((m.lines().find(line => line.includes(`${CONFIG_ROW_MARK} `)) ?? '').split(`${CONFIG_ROW_MARK} `)[1] ?? '').split(/\s{2,}/)[0]?.trim() ?? ''
const storedAdvisor = (): unknown => JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8').trim() || '{}').advisor

for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
  const size = `${columns}x${rows}`
  section(`§2 the /config popup at ${size}: the three Advisor rows beside the Local rows, both switches off by default`)
  const m = await mount(columns, rows)
  m.push('advisor')
  await settle(150)
  m.push(KEY.enter)
  await settle(150)
  const screen = m.lines()
  const positions = ['Advisor', 'Advisor for crewmates', 'Advisor interval'].map(label => screen.findIndex(line => line.includes(`  ${label} `) || line.includes(`${CONFIG_ROW_MARK} ${label} `)))
  check(`${size}: the three rows stand in order`, positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)), positions.join(','))
  check(`${size}: the Advisor row is selected after the search and reads off`, selectedLabel(m) === 'Advisor' && rowOf(m, 'Advisor ').includes('off'), `${selectedLabel(m)} · ${rowOf(m, 'Advisor ')}`)
  check(`${size}: the interval row reads 10 minutes (red on the base: 10 turns)`, rowOf(m, 'Advisor interval').includes('10 minutes') && !rowOf(m, 'Advisor interval').includes('turns'), rowOf(m, 'Advisor interval'))
  check(`${size}: crewmates have their own off row`, rowOf(m, 'Advisor for crewmates').includes('off'), rowOf(m, 'Advisor for crewmates'))
  if (columns >= 100) check(`${size}: the note under the row says the note is for the agent, never you, and names /submodels for the model`, flatScreen(m).includes('addressed to the agent, never to you') && flatScreen(m).includes('/submodels'), flatScreen(m).slice(0, 600))
  save(`config-advisor-${size}`, m)
  m.push(KEY.esc)
  await settle(150)
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§3 master on leaves crewmates off; the separate opt-in and interval write independently; esc reverts all three')
{
  const m = await mount(178, 51)
  m.push('advisor')
  await settle(150)
  m.push(KEY.enter)
  await settle(150)
  check('the Advisor row is selected alone', selectedLabel(m) === 'Advisor', selectedLabel(m))
  m.push(KEY.right)
  await settle(200)
  check('→ turns the advisor on: the row reads on · every 10 minutes and the file holds { enabled: true }', rowOf(m, 'Advisor ').includes('on · every 10 minutes') && JSON.stringify(storedAdvisor()) === JSON.stringify({ enabled: true }) && readAdvisorSettings().enabled, `${rowOf(m, 'Advisor ')} · ${JSON.stringify(storedAdvisor())}`)
  check('turning on the master leaves crewmates off', !readAdvisorSettings().crewmates && rowOf(m, 'Advisor for crewmates').includes('off'))
  m.push(KEY.down)
  await settle(100)
  check('↓ selects the separate crewmate row', selectedLabel(m) === 'Advisor for crewmates', selectedLabel(m))
  save('config-advisor-crewmates-off-178x51', m)
  m.push(KEY.right)
  await settle(200)
  check('→ explicitly opts crewmates in without changing the interval', readAdvisorSettings().crewmates && readAdvisorSettings().minutes === 10 && JSON.stringify(storedAdvisor()) === JSON.stringify({ enabled: true, crewmates: true }), JSON.stringify(storedAdvisor()))
  check('the crewmate row on screen reads on · may result in high spend', rowOf(m, 'Advisor for crewmates').includes('on · may result in high spend'), rowOf(m, 'Advisor for crewmates'))
  save('config-advisor-crewmates-on-178x51', m)
  m.push(KEY.down)
  await settle(100)
  check('↓ selects the interval row', selectedLabel(m) === 'Advisor interval', selectedLabel(m))
  m.push(KEY.right)
  await settle(200)
  check('→ steps the interval to 20 minutes and persists it beside the switch under the minutes key', rowOf(m, 'Advisor interval').includes('20 minutes') && JSON.stringify(storedAdvisor()) === JSON.stringify({ enabled: true, crewmates: true, minutes: 20 }) && readAdvisorSettings().minutes === 20, `${rowOf(m, 'Advisor interval')} · ${JSON.stringify(storedAdvisor())}`)
  save('config-advisor-on-178x51', m)
  m.push(KEY.esc)
  await settle(300)
  check('esc reverts all three to their mount-time values: the block is gone from the file', storedAdvisor() === undefined && !readAdvisorSettings().enabled && !readAdvisorSettings().crewmates && readAdvisorSettings().minutes === 10, JSON.stringify(storedAdvisor()))
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§4 ↵ saves: the advisor on at 30 minutes survives the close and reads back through the service')
{
  const m = await mount(178, 51)
  m.push('advisor')
  await settle(150)
  m.push(KEY.enter)
  await settle(150)
  m.push(KEY.right)
  await settle(200)
  m.push(KEY.down)
  await settle(100)
  m.push(KEY.right)
  await settle(200)
  check('the crewmate switch is explicitly on before saving', readAdvisorSettings().crewmates && rowOf(m, 'Advisor for crewmates').includes('on'))
  m.push(KEY.down)
  await settle(100)
  m.push(KEY.left)
  await settle(200)
  check('← at the bottom rung stays at 10 minutes (the ladder starts there; the floor of 1 is for a hand-edited file)', rowOf(m, 'Advisor interval').includes('10 minutes') && readAdvisorSettings().minutes === 10, rowOf(m, 'Advisor interval'))
  m.push(KEY.right)
  await settle(200)
  m.push(KEY.right)
  await settle(200)
  check('→ → steps 10 → 20 → 30', rowOf(m, 'Advisor interval').includes('30 minutes'), rowOf(m, 'Advisor interval'))
  check('the switch is on at every 30 minutes', rowOf(m, 'Advisor ').includes('on · every 30 minutes'), rowOf(m, 'Advisor '))
  m.push(KEY.enter)
  await settle(300)
  check('↵ closes the popup with the values kept', !store.isSettingsPopupOpen() && JSON.stringify(storedAdvisor()) === JSON.stringify({ enabled: true, crewmates: true, minutes: 30 }) && readAdvisorSettings().enabled && readAdvisorSettings().minutes === 30, JSON.stringify(storedAdvisor()))
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
  check('the global config carries no other advisor key', JSON.stringify(Object.keys((getGlobalConfig().advisor ?? {}) as object).sort()) === JSON.stringify(['crewmates', 'enabled', 'minutes']))
}

section('§5 a saved turn count from an older build: the `seats` key is dropped at read (a turn count does not convert), the default interval applies, and the next save no longer carries it (red on the base: seats was the interval)')
{
  const { readGlobalConfigAgain } = await import('../../src/utils/config/globalConfig.js')
  const { dropRetiredAdvisorConfigKeys, DROPPED_ADVISOR_CONFIG_KEYS } = await import('../../src/migrations/migrateConfigSpellings.js')
  const { setAdvisorMinutes } = ready.service
  check('the retired advisor keys name seats alone', JSON.stringify(DROPPED_ADVISOR_CONFIG_KEYS) === JSON.stringify(['seats']))
  const untouched = { advisor: { enabled: true, minutes: 20 } }
  check('the pure drop: a block without seats comes back as the same object', dropRetiredAdvisorConfigKeys(untouched) === untouched && dropRetiredAdvisorConfigKeys({}) !== undefined)
  check('the pure drop keeps the switches and loses the turn count; a block that was only a turn count goes entirely', JSON.stringify(dropRetiredAdvisorConfigKeys({ advisor: { enabled: true, crewmates: true, seats: 20 } } as never)) === JSON.stringify({ advisor: { enabled: true, crewmates: true } }) && JSON.stringify(dropRetiredAdvisorConfigKeys({ other: 1, advisor: { seats: 5 } } as never)) === JSON.stringify({ other: 1 }))
  const file = join(HOME, '.mercury.json')
  const onDisk = JSON.parse(readFileSync(file, 'utf8').trim() || '{}') as Record<string, unknown>
  onDisk.advisor = { enabled: true, crewmates: true, seats: 20 }
  await settle(20)
  writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`)
  readGlobalConfigAgain()
  check('read back from disk, the config holds the switches and no seats, and the service reads the default ten minutes', JSON.stringify(getGlobalConfig().advisor) === JSON.stringify({ enabled: true, crewmates: true }) && readAdvisorSettings().enabled && readAdvisorSettings().crewmates && readAdvisorSettings().minutes === 10, JSON.stringify(getGlobalConfig().advisor))
  setAdvisorMinutes(20)
  check('the next save writes the minutes key beside the switches and the turn count is gone from the file', JSON.stringify(storedAdvisor()) === JSON.stringify({ enabled: true, crewmates: true, minutes: 20 }), JSON.stringify(storedAdvisor()))
}

await finish()
