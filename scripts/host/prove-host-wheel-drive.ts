import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LlmHostQuestion, LlmHostRoad } from '../../src/services/llmHost/index.js'
import type { ScrollBoxHandle } from '../../src/ink/components/ScrollBox.js'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const home = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'host-wheel-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
pinSourceRef()
const frameOption = process.argv.indexOf('--frames')
const frames = frameOption < 0 ? undefined : process.argv[frameOption + 1]
if (frames) mkdirSync(frames, { recursive: true })
const nativeFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = Object.assign(async () => { networkCalls++; throw new Error('The wheel fixture makes no network calls') }, nativeFetch)

const React = await import('react')
const { Box, Text, useInput } = await import('../../src/ink.ts')
const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.tsx')
const { InkInstanceContext } = await import('../../src/ink/components/InkInstanceContext.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { ScrollKeybindingHandler } = await import('../../src/components/ScrollKeybindingHandler.tsx')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
const { topOverlay } = await import('../../src/context/overlayStack.ts')
const { interpretKey } = await import('../../src/ink/input/interpreter.ts')
const { InputEvent } = await import('../../src/ink/events/input-event.ts')
enableConfigs()

const h = React.createElement
const wheel = (down: boolean, x = 40, y = 15) => `\x1b[<${down ? 65 : 64};${x};${y}M`
const x10 = (down: boolean) => '\x1b[M' + String.fromCharCode(32 + (down ? 65 : 64), 72, 47)
const seen: string[] = []
let ink: React.ContextType<typeof InkInstanceContext>
function Tap({ name }: { name: string }): null {
  ink = React.useContext(InkInstanceContext)
  useInput((_input, _key, event) => { seen.push(name + ':' + event.keypress.name) })
  return null
}
const scrollRef = React.createRef<ScrollBoxHandle>()
let mounted: Mounted | undefined
let checks = 0
const check = (label: string, condition: unknown): void => {
  assert.ok(condition, label + '\n' + (mounted?.screen() ?? ''))
  checks++
  console.log('PASS ' + label)
}
const capture = async (name: string, columns: number) => {
  if (!frames) return
  const { gridToPng } = await import('../ui/gridToPng.ts')
  const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(columns)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
  const path = join(frames, name + '.json')
  writeFileSync(path, JSON.stringify({ grid, cols: columns, rows: 44 }))
  writeFileSync(join(frames, name + '.txt'), mounted!.screen())
  await gridToPng(path, join(frames, name + '.png'))
}
const selected = (): number | null => {
  const match = /› Row (\d+)/.exec(mounted?.screen() ?? '')
  return match ? Number(match[1]) : null
}
const visible = (): number[] => [...(mounted?.screen() ?? '').matchAll(/(?:› |  )Row (\d+)/g)].map(match => Number(match[1]))
const until = async (predicate: () => boolean, label: string) => check(label, await waitFor(predicate, 4000))
const step = async (bytes: string, target: number, label: string) => {
  mounted!.push(bytes)
  await until(() => selected() === target, label)
}
const wheelMove = async (bytes: string, target: number, label: string) => {
  const before = seen.length
  const transcript = scrollRef.current!.getScrollTop()
  mounted!.push(bytes)
  const reached = await waitFor(() => selected() === target, 1500)
  console.log(JSON.stringify({ label, target, selected: selected(), input: seen.slice(before), transcriptBefore: transcript, transcriptAfter: scrollRef.current!.getScrollTop(), owner: topOverlay()?.id ?? null }))
  check(label, reached)
  check(label + ' leaves the transcript still', scrollRef.current!.getScrollTop() === transcript)
}
const close = async () => {
  mounted!.push(KEY.esc)
  await until(() => !popup.isSettingsPopupOpen() && topOverlay() === null, 'Escape closes the popup and releases its input ownership')
}
const plan = (step: string): LlmHostQuestion => ({
  step,
  title: ({ 'bank': 'Bank', 'door-models': 'Which model?', 'pod-list': "Pods I’m paying for", 'vendor': 'Which provider?' } as Record<string, string>)[step]!,
  found: 'Fixture choices',
  willRun: '',
  initial: '0',
  rows: Array.from({ length: 40 }, (_, index) => ({ value: String(index), label: 'Row ' + index.toString().padStart(2, '0') + (step === 'door-models' ? ' · Model' : '') })),
  ...(step === 'door-models' ? { search: { placeholder: 'Type to search', query: '' } } : {}),
})
const answers: Array<string | null> = []
const roadFor = (question: LlmHostQuestion): LlmHostRoad => async ask => {
  answers.push(await ask(question))
  return { ok: true, words: 'Fixture complete' }
}
const mount = async (columns: number) => {
  mounted = await mountOffscreen(h(AppStateProvider, {}, h(ThemeProvider, {}, h(KeybindingSetup, {}, h(Box, { flexDirection: 'column', width: columns, height: 44 },
    h(Tap, { name: 'before-scroll' }),
    h(ScrollKeybindingHandler, { scrollRef, isActive: true }),
    h(Tap, { name: 'after-scroll' }),
    h(ScrollBox, { ref: scrollRef, height: 40, flexDirection: 'column' }, h(Box, { flexDirection: 'column', flexShrink: 0 }, ...Array.from({ length: 120 }, (_, index) => h(Text, { key: index }, 'Transcript ' + index)))),
    h(SettingsPopupSlot, { overlay: true }),
  )))), columns, 44, { mouseTracking: true })
  await until(() => scrollRef.current !== null && scrollRef.current.getScrollHeight() > scrollRef.current.getViewportHeight(), 'the background transcript really scrolls')
}
const chatWheel = async () => {
  scrollRef.current!.scrollTo(20)
  await until(() => scrollRef.current!.getScrollTop() === 20, 'chat starts at a known scroll position')
  mounted!.push(wheel(true))
  await until(() => scrollRef.current!.getScrollTop() > 20, 'without a popup the chat still receives the wheel')
}
try {
  const parsed = interpretKey(wheel(true))
  check('SGR keeps wheeldown and its pointer coordinates', parsed.name === 'wheeldown' && parsed.x === 40 && parsed.y === 15 && new InputEvent(parsed).key.wheelDown)
  for (const columns of [120, 80]) {
    await mount(columns)
    await chatWheel()
    for (const kind of ['bank', 'door-models', 'pod-list', 'vendor']) {
      const answersBefore = answers.length
      popup.openSettingsPopup(llmHostPopupRequest(roadFor(plan(kind))))
      await until(() => selected() === 0, columns + ' ' + kind + ' opens on row zero')
      await wheelMove(wheel(true), 1, columns + ' ' + kind + ': one notch selects the next row')
      await capture(columns + '-' + kind + '-wheel-next', columns)
      await wheelMove(wheel(false), 0, columns + ' ' + kind + ': the first reverse notch selects the previous row')
      await wheelMove(x10(true), 1, columns + ' ' + kind + ': X10 wheel follows the same route')
      await wheelMove(wheel(true).repeat(4), 5, columns + ' ' + kind + ': a coalesced burst moves once per notch')
      await step(KEY.down, 6, 'Down-arrow retains its one-row move')
      await step(KEY.up, 5, 'Up-arrow retains its one-row move')
      const pageRows = visible().length
      check('the fixture overflows the popup and advertises paging', pageRows > 1 && pageRows < 40 && mounted!.screen().includes('pgup/pgdn page'))
      await step('\x1b[6~', Math.min(39, 5 + pageRows), 'PageDown keeps its measured page stride')
      const beforeUp = selected()!
      const upPageRows = visible().length
      await step('\x1b[5~', Math.max(0, beforeUp - upPageRows), 'PageUp keeps its measured page stride')
      while (selected()! < 39) await step(wheel(true), selected()! + 1, 'wheel reaches the next visible row across the page edge')
      check('the last row remains visible with earlier rows above', visible().includes(39) && !visible().includes(0))
      await capture(columns + '-' + kind + '-wheel-end', columns)
      await wheelMove(wheel(true), 39, 'the last row clamps without wrapping')
      while (selected()! > 0) await step(wheel(false), selected()! - 1, 'reverse wheel returns across each page edge')
      await wheelMove(wheel(false), 0, 'the first row clamps without wrapping')
      check('wheel and page keys never accept a choice', answers.length === answersBefore)
      await close()
    }
    const short = { ...plan('bank'), initial: undefined, rows: plan('bank').rows!.slice(0, 2) }
    popup.openSettingsPopup(llmHostPopupRequest(roadFor(short)))
    await until(() => mounted!.screen().includes('Fixture choices') && selected() === null, 'an unsuggested short list starts with no selection')
    await wheelMove(wheel(true), 0, 'the first downward notch selects the first row')
    await close()
    popup.openSettingsPopup(llmHostPopupRequest(roadFor(short)))
    await until(() => mounted!.screen().includes('Fixture choices') && selected() === null, 'the short list reopens without a selection')
    await wheelMove(wheel(false), 1, 'the first upward notch selects the last row')
    await close()
    const inputAnswers = answers.length
    popup.openSettingsPopup(llmHostPopupRequest(roadFor({ step: 'name', title: 'Name', found: 'Fixture text input', willRun: '' })))
    await until(() => mounted!.screen().includes('Fixture text input'), 'the dialog still opens text input while owning the overlay')
    mounted!.push('fixture-name')
    await until(() => mounted!.screen().includes('fixture-name'), 'text entry still receives typed characters')
    mounted!.push(KEY.enter)
    await until(() => answers.length === inputAnswers + 1 && answers.at(-1) === 'fixture-name', 'Enter submits the text input exactly once')
    await close()
    await chatWheel()
    ink!.setMouseTrackingEnabled(false)
    check('mouse-off disables capture', !ink!.isMouseTrackingEnabled())
    popup.openSettingsPopup(llmHostPopupRequest(roadFor(plan('bank'))))
    await until(() => selected() === 0, 'mouse-off popup opens')
    check('opening the popup does not re-enable mouse capture', !ink!.isMouseTrackingEnabled())
    await step(KEY.down, 1, 'mouse-off alternate-scroll arrows navigate the popup')
    await step(KEY.up, 0, 'mouse-off reverse arrows navigate the popup')
    await close()
    check('closing the popup leaves native selection mode intact', !ink!.isMouseTrackingEnabled())
    mounted!.unmount()
    mounted = undefined
  }
  check('the proof made no network calls', networkCalls === 0)
  console.log('HOST WHEEL DRIVE GREEN — ' + checks + ' checks; real parser, keybinding provider, background scroller and popup at 120/80 columns; no desktop or network calls')
} finally {
  globalThis.fetch = nativeFetch
  mounted?.unmount()
  popup.closeSettingsPopup()
  rmSync(home, { recursive: true, force: true })
}
