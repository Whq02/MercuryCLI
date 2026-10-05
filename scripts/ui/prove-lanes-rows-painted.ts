#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lanes-rows-painted-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER

const React = (await import('react')).default
const { render, ThemeProvider } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
await import(join(ROOT, 'src/tasks.ts'))
const { HelmLanesRail } = await import(join(ROOT, 'src/components/HelmLanesRail.tsx'))
const focus = await import(join(ROOT, 'src/utils/cockpit/helmFocus.ts'))
const activity = await import(join(ROOT, 'src/utils/cockpit/cockpitActivity.ts'))
const { createTaskStateBase } = await import(join(ROOT, 'src/Task.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const T0 = 1_700_000_000_000

function agentTask(id: string, description: string, status: string): Record<string, unknown> {
  return {
    ...createTaskStateBase(id, 'local_agent', description, `toolu_${id}`),
    type: 'local_agent',
    status,
    agentId: id,
    prompt: 'p',
    agentType: 'mercury-crew',
    model: 'claude-fable-5-1',
    isBackgrounded: true,
    retain: false,
    startTime: T0,
  }
}
function shellTask(id: string, command: string): Record<string, unknown> {
  return {
    ...createTaskStateBase(id, 'local_bash', '', `toolu_${id}`),
    type: 'local_bash',
    status: 'running',
    command,
    description: '',
    startTime: T0,
    outputFile: '/tmp/x',
  }
}

type Mounted = { frame: () => string; paint: (availRows: number | undefined) => Promise<void>; close: () => Promise<void> }
async function mount(tasks: Record<string, unknown>, availRows: number | undefined, width = 28, merged = false): Promise<Mounted> {
  focus.resetHelmFocusForTest()
  activity.resetCockpitActivityForTests()
  let written = ''
  const stdout = Object.assign(
    new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }),
    { columns: width + 2, rows: 40, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const state = { ...getDefaultAppState(), tasks }
  const tree = (rows: number | undefined) => h(AppStateProvider as never, { initialState: state }, h(HelmLanesRail as never, { width, mergedTelemetry: merged, availRows: rows }))
  const instance = await render(tree(availRows), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  await settle(250)
  return {
    frame: () => strip(instance.lastFrame()),
    paint: async rows => {
      instance.rerender(h(ThemeProvider as never, null, tree(rows)))
      await settle(250)
    },
    close: async () => {
      instance.unmount?.()
      await settle(30)
    },
  }
}
const caretRows = (frame: string): string[] => frame.split('\n').filter(l => /^│ ❯ |^❯ /.test(l) && !l.startsWith('❯ lanes') && !/❯ WORKBENCH/.test(l))

section('§1 every published row is a painted row: the idle rail shows its caret the moment it takes focus')
for (const [name, tasks] of [['solo', {}], ['runs-only', { s1: shellTask('s1', 'bun run build') }]] as const) {
  const m = await mount(tasks as Record<string, unknown>, undefined)
  const before = m.frame()
  check(`${name}: no CREW section is painted`, !before.includes('CREW'), before.slice(0, 200))
  const published = focus.getHelmRows('lanes') as Array<{ kind: string; label: string }>
  check(`${name}: RED ON THE BASE — the published model carries no row the rail did not paint (no crew:root under a rail without a CREW section)`, !published.some(r => r.label === 'crew:root'), published.map(r => r.label).join(' | '))
  focus.setHelmFocus('lanes')
  await settle(250)
  const focused = m.frame()
  check(`${name}: RED ON THE BASE — Tab into the rail paints the caret on the first row at once`, caretRows(focused).length === 1, JSON.stringify(caretRows(focused)))
  check(`${name}: the first published row IS the row under the caret (the WORKBENCH card${name === 'runs-only' ? ' comes after the runs' : ''})`, published[0] !== undefined && (name === 'solo' ? published[0].label === 'workbench:last' : published[0].label === 'run:s1'), published[0]?.label)
  focus.moveHelmCursor('lanes', 1)
  await settle(250)
  check(`${name}: one ↓ moves the caret one painted row down`, caretRows(m.frame()).length === 1 && caretRows(m.frame())[0] !== caretRows(focused)[0], JSON.stringify(caretRows(m.frame())))
  await m.close()
}

section('§2 the section holding the cursor never sheds, whatever the label of the row under it')
{
  const m = await mount({ a1: agentTask('a1', 'count the harbour', 'running') }, 40)
  const tall = m.frame()
  check('tall: the CREW section with the local agent is painted', tall.includes('CREW') && tall.includes('count the'), tall.slice(0, 300))
  focus.setHelmFocus('lanes')
  focus.moveHelmCursor('lanes', 1)
  await settle(250)
  const row = (focus.getHelmRows('lanes') as Array<{ kind: string; label: string }>)[focus.getHelmCursor('lanes')]
  check('the cursor rests on the local agent row, whose label is its bare name', row !== undefined && row.kind === 'crewmate' && row.label === 'count the harbour', JSON.stringify(row))
  await m.paint(9)
  const short = m.frame()
  check('RED ON THE BASE: under height pressure the CREW section holding the cursor stays painted', short.includes('CREW') && short.includes('count the'), short)
  check('…with the caret still on the agent row', caretRows(short).some(l => l.includes('count the')), JSON.stringify(caretRows(short)))
  check('…and the card that yields first is the one shed', !short.includes('WORKBENCH') && short.includes('more: /workbench'), short)
  await m.close()
}
{
  const m = await mount({ a1: agentTask('a1', 'count the harbour', 'running') }, 40)
  const rest = (focus.getHelmRows('lanes') as Array<{ kind: string; label: string }>)[focus.getHelmCursor('lanes')]
  check('at rest (never focused) the cursor rests on the first published row, in the CREW section', rest !== undefined && rest.label.startsWith('crew'), JSON.stringify(rest))
  await m.paint(9)
  const short = m.frame()
  check('RED ON THE CURRENT TIP: a busy rail at rest, too short even for its CREW section, keeps the section under the resting cursor and clips the sections below (the base shape)', short.includes('CREW') && short.includes('count the'), short)
  check('…the card below is the one shed, with the pointer', !short.includes('WORKBENCH') && short.includes('more: /workbench'), short)
  await m.close()
}

section('§3 the shed bills the rows it paints: a merged rail whose painted rows exactly fill the glass sheds nothing')
{
  const m = await mount({}, 40, 24, true)
  await settle(400)
  const tall = m.frame()
  const inked = tall.split('\n').filter(l => l.trim() !== '')
  check('tall: the merged solo rail paints its banner, the WORKBENCH card, the four NEXT hints, FILES and the three-row TELEMETRY glance (14 inked rows) with their flat headers and gaps', tall.includes('WORKBENCH') && tall.includes('NEXT') && tall.includes('FILES') && tall.includes('TELEMETRY') && !tall.includes('RECENT') && inked.length === 14, `${inked.length} inked: ${tall}`)
  const glass = 1 + (1 + 2) + (1 + 2) + (1 + 2) + (3 + 2)
  await m.paint(glass)
  const exact = m.frame()
  check(`RED ON THE BASE: with exactly ${glass} rows of glass (banner 1, card 1+2, hint 1+2, files 1+2, glance 3+2) the rail sheds nothing`, exact.includes('WORKBENCH') && !exact.includes('more: /workbench'), exact)
  await m.paint(glass - 1)
  const tight = m.frame()
  check('one row less keeps the WORKBENCH card under the resting cursor and sheds the next in the ladder, with the pointer (the base shape at rest)', tight.includes('WORKBENCH') && !tight.includes('NEXT') && tight.includes('more: /help'), tight)
  await m.paint(40)
  focus.setHelmFocus('lanes')
  await settle(250)
  await m.paint(glass - 1)
  const held = m.frame()
  check('…and once the rail holds focus, the section under the cursor stays and the next in the ladder yields', held.includes('WORKBENCH') && !held.includes('NEXT') && held.includes('more: /help'), held)
  await m.close()
}

console.log(failures === 0 ? '\nprove-lanes-rows-painted: all green' : `\nprove-lanes-rows-painted: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
