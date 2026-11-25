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
const { render, ThemeProvider } = await import(join(ROOT, 'src/screen/themedRenderer.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/screen/app-state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/screen/app-state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
enableConfigs()
await import(join(ROOT, 'src/engine/tasks/tasks.ts'))
const { HelmLanesRail } = await import(join(ROOT, 'src/screen/fullscreen-layout/HelmLanesRail.tsx'))
const focus = await import(join(ROOT, 'src/screen/cockpit/helmFocus.ts'))
const activity = await import(join(ROOT, 'src/screen/cockpit/cockpitActivity.ts'))
const { createTaskStateBase } = await import(join(ROOT, 'src/engine/tasks/taskBase.ts'))

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
    ...createTaskStateBase({ task_id: id, task_type: 'local_agent', description, call_id: `toolu_${id}` }),
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
    ...createTaskStateBase({ task_id: id, task_type: 'local_bash', description: '', call_id: `toolu_${id}` }),
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
  const tree = (rows: number | undefined) => h(AppStateProvider as never, { initialState: state }, h(HelmLanesRail as never, { width, mergedVitals: merged, availRows: rows }))
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
const caretRows = (frame: string): string[] => frame.split('\n').filter(l => /^│ ❯ |^❯ /.test(l) && !l.startsWith('❯ lanes') && !/❯ workbench/.test(l))

section('§1 every published row is a painted row: the idle rail shows its caret the moment it takes focus')
for (const [name, tasks] of [['solo', {}], ['runs-only', { s1: shellTask('s1', 'bun run build') }]] as const) {
  const m = await mount(tasks as Record<string, unknown>, undefined)
  const before = m.frame()
  check(`${name}: no CREW section is painted`, !before.includes('crew ·'), `${before.slice(0, 200)} — the rail should paint no CREW section for this task set; see buildLanesModel in src/screen/cockpit-gauges/helmLanesModel.ts and HelmLanesRail in src/screen/fullscreen-layout/HelmLanesRail.tsx`)
  const published = focus.getHelmRows('lanes') as Array<{ kind: string; label: string }>
  check(`${name}: RED ON THE BASE — the published model carries no row the rail did not paint (no crew:root under a rail without a CREW section)`, !published.some(r => r.label === 'crew:root'), `${published.map(r => r.label).join(' | ')} — publishHelmRows in src/screen/fullscreen-layout/HelmLanesRail.tsx must publish only the rows the rail paints`)
  focus.setHelmFocus('lanes')
  await settle(250)
  const focused = m.frame()
  check(`${name}: RED ON THE BASE — Tab into the rail paints the caret on the first row at once`, caretRows(focused).length === 1, `${JSON.stringify(caretRows(focused))} — the rail must paint exactly one caret row once setHelmFocus('lanes') runs; see HelmLanesRail in src/screen/fullscreen-layout/HelmLanesRail.tsx`)
  check(`${name}: the first published row IS the row under the caret (the WORKBENCH card${name === 'runs-only' ? ' comes after the runs' : ''})`, published[0] !== undefined && (name === 'solo' ? published[0].label === 'workbench:last' : published[0].label === 'run:s1'), `${published[0]?.label} — the first row published by HelmLanesRail (src/screen/fullscreen-layout/HelmLanesRail.tsx) must be the first row painted`)
  focus.moveHelmCursor('lanes', 1)
  await settle(250)
  check(`${name}: one ↓ moves the caret one painted row down`, caretRows(m.frame()).length === 1 && caretRows(m.frame())[0] !== caretRows(focused)[0], `${JSON.stringify(caretRows(m.frame()))} — moveHelmCursor in src/screen/cockpit/helmFocus.ts must move the caret to the next painted row`)
  await m.close()
}

section('§2 the section holding the cursor never sheds, whatever the label of the row under it')
{
  const m = await mount({ a1: agentTask('a1', 'count the harbour', 'running') }, 40)
  const tall = m.frame()
  check('tall: the CREW section with the local agent is painted', tall.includes('crew ·') && tall.includes('count the'), `${tall.slice(0, 300)} — a running local_agent task must paint a CREW section; see buildLanesModel in src/screen/cockpit-gauges/helmLanesModel.ts`)
  focus.setHelmFocus('lanes')
  focus.moveHelmCursor('lanes', 1)
  await settle(250)
  const row = (focus.getHelmRows('lanes') as Array<{ kind: string; label: string }>)[focus.getHelmCursor('lanes')]
  check('the cursor rests on the local agent row, whose label is its bare name', row !== undefined && row.kind === 'crewmate' && row.label === 'count the harbour', `${JSON.stringify(row)} — the first row HelmLanesRail publishes for a local agent must be a crewmate row labelled with its description (src/screen/fullscreen-layout/HelmLanesRail.tsx)`)
  await m.paint(9)
  const short = m.frame()
  check('RED ON THE BASE: under height pressure the CREW section holding the cursor stays painted', short.includes('crew ·') && short.includes('count the'), `${short} — the shed in buildLanesModel (src/screen/cockpit-gauges/helmLanesModel.ts) must keep the section holding the cursor`)
  check('…with the caret still on the agent row', caretRows(short).some(l => l.includes('count the')), `${JSON.stringify(caretRows(short))} — the caret must stay on the agent row after the shed; see buildLanesModel in src/screen/cockpit-gauges/helmLanesModel.ts`)
  check('…and the card that yields first is the one shed', !short.includes('❯ workbench') && short.includes('more: /workbench'), `${short} — the shed in buildLanesModel (src/screen/cockpit-gauges/helmLanesModel.ts) must drop the WORKBENCH card first and leave the pointer`)
  await m.close()
}
{
  const m = await mount({ a1: agentTask('a1', 'count the harbour', 'running') }, 40)
  const rest = (focus.getHelmRows('lanes') as Array<{ kind: string; label: string }>)[focus.getHelmCursor('lanes')]
  check('at rest (never focused) the cursor rests on the first published row, in the CREW section', rest !== undefined && rest.label.startsWith('crew'), `${JSON.stringify(rest)} — the unfocused cursor must rest on the first published row, which HelmLanesRail (src/screen/fullscreen-layout/HelmLanesRail.tsx) puts in the CREW section`)
  await m.paint(9)
  const short = m.frame()
  check('RED ON THE CURRENT TIP: a busy rail at rest, too short even for its CREW section, keeps the section under the resting cursor and clips the sections below (the base shape)', short.includes('crew ·') && short.includes('count the'), `${short} — buildLanesModel (src/screen/cockpit-gauges/helmLanesModel.ts) must keep the section under the resting cursor and clip the sections below`)
  check('…the card below is the one shed, with the pointer', !short.includes('❯ workbench') && short.includes('more: /workbench'), `${short} — buildLanesModel (src/screen/cockpit-gauges/helmLanesModel.ts) must shed the card below the cursor's section and leave the pointer`)
  await m.close()
}

section('§3 the shed bills the rows it paints: a merged rail whose painted rows exactly fill the glass sheds nothing')
{
  const m = await mount({}, 40, 24, true)
  await settle(400)
  const tall = m.frame()
  const inked = tall.split('\n').filter(l => l.trim() !== '')
  check('tall: the merged solo rail paints its banner, the WORKBENCH card, the three NEXT hints, FILES and the three-row VITALS glance (13 inked rows) with their flat headers and gaps', tall.includes('\nworkbench\n') && tall.includes('\nnext\n') && tall.includes('\nfiles ·') && tall.includes('\nvitals\n') && !tall.includes('\nrecent\n') && inked.length === 13, `${inked.length} inked: ${tall} — the merged solo rail's sections come from buildLanesModel in src/screen/cockpit-gauges/helmLanesModel.ts`)
  const glass = 1 + (1 + 2) + (1 + 2) + (1 + 2) + (3 + 2)
  await m.paint(glass)
  const exact = m.frame()
  check(`RED ON THE BASE: with exactly ${glass} rows of glass (banner 1, card 1+2, hint 1+2, files 1+2, glance 3+2) the rail sheds nothing`, exact.includes('\nworkbench\n') && !exact.includes('more: /workbench'), `${exact} — the shed budget in buildLanesModel (src/screen/cockpit-gauges/helmLanesModel.ts) must count the rows it paints, so a rail that exactly fills availRows sheds nothing`)
  await m.paint(glass - 1)
  const tight = m.frame()
  check('one row less keeps the WORKBENCH card under the resting cursor and sheds the next in the ladder, with the pointer (the base shape at rest)', tight.includes('\nworkbench\n') && !tight.includes('\nnext\n') && tight.includes('more: /help'), `${tight} — buildLanesModel (src/screen/cockpit-gauges/helmLanesModel.ts) must shed the next section in its ladder and leave the pointer`)
  await m.paint(40)
  focus.setHelmFocus('lanes')
  await settle(250)
  await m.paint(glass - 1)
  const held = m.frame()
  check('…and once the rail holds focus, the section under the cursor stays and the next in the ladder yields', held.includes('\nworkbench\n') && !held.includes('\nnext\n') && held.includes('more: /help'), `${held} — buildLanesModel (src/screen/cockpit-gauges/helmLanesModel.ts) must keep the section under the cursor of a focused rail`)
  await m.close()
}

console.log(failures === 0 ? '\nprove-lanes-rows-painted: all green' : `\nprove-lanes-rows-painted: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
