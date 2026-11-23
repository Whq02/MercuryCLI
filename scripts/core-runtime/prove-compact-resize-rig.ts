#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-rig-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.BROWSER = '/usr/bin/true'

const React = await import('react')
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.tsx')
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { default: Composer } = await import('../../src/screen/composer/Composer.tsx')
const { BackgroundTasksDialog } = await import('../../src/screen/tasks/BackgroundTasksDialog.tsx')
const { useCompactWorkControls } = await import('../../src/screen/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/screen/chat/useGlobalKeybindings.tsx')
const { useLayoutChrome } = await import('../../src/screen/fullscreen-layout/layoutChromeContext.tsx')
const { useTerminalSize, useRealTerminalSize } = await import('../../src/screen/fullscreen-layout/useTerminalSize.ts')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
const { default: instances } = await import('../../src/screen/renderer/instances.ts')
const h = React.createElement
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = '', hint = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!good && hint ? ` | ${hint}` : ''}`)
}
async function until(label: string, predicate: () => boolean): Promise<void> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, 5000)
  while (!predicate() && !expired) await new Promise<void>(resolve => setImmediate(resolve))
  clearTimeout(timer)
  check(label, predicate(), '', 'the condition did not hold within 5 seconds; read the behaviour it names in this script Harness and in the components it mounts (src/screen/composer/Composer.tsx, src/screen/tasks/CompactWorkSummary.tsx, src/screen/fullscreen-layout/FullscreenLayout.tsx)')
}
class Output extends EventEmitter {
  isTTY = true
  columns = 120
  rows = 40
  writes: string[] = []
  write(value: string | Uint8Array): boolean { this.writes.push(String(value)); return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  chunks: string[] = []
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): string | null { return this.chunks.shift() ?? null }
  get readableLength(): number { return this.chunks.reduce((n, value) => n + value.length, 0) }
  push(value: string): void { this.chunks.push(value); this.emit('readable') }
}
const hardLimit = setTimeout(() => { console.error('compact rig exceeded its deadline'); process.exit(1) }, 90_000)
hardLimit.unref()
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }

for (const editorMode of ['emacs', 'vim'] as const) {
  saveGlobalConfig(config => ({ ...config, editorMode, prStatusFooterEnabled: false }))
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output()
  const stdin = new Input()
  let frames = 0
  const ink = new ScreenInstance({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false, onFrame: () => { frames++ } })
  instances.set(stdout as never, ink)
  const scrollRef = React.createRef<import('../../src/screen/renderer/elements/ScrollBox.tsx').ScrollBoxHandle>()
  const insertRef = { current: null } as React.MutableRefObject<import('../../src/screen/composer/Composer.tsx').ComposerProps['insertTextRef']['current']>
  const sent: string[] = []
  let control: ReturnType<typeof useCompactWorkControls>['controls'] | null = null
  let physical = { columns: 0, rows: 0 }
  let local = { columns: 0, rows: 0 }
  let compact = false
  let transcriptMounts = 0
  function Transcript(): React.ReactNode {
    physical = useRealTerminalSize()
    local = useTerminalSize()
    React.useEffect(() => { transcriptMounts++ }, [])
    return h(Text, null, Array.from({ length: 100 }, (_, i) => `row ${i} alpha beta gamma`).join('\n'))
  }
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    control = controls
    compact = useLayoutChrome().isCompact
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(FullscreenLayout, {
        scrollRef,
        scrollable: h(Transcript),
        statusBand: h(Text, null, 'activity specimen'),
        statusBandActive: false,
        modal: focus === 'detail' ? h(BackgroundTasksDialog, { entry: 'compact-summary', compactControls: controls, onDone: () => controls.set('composer'), toolUseContext: {} as never }) : undefined,
        bottom: h(Composer, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: sent.length, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async (value: string) => { sent.push(value); pending.clearForSubmit(value) },
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        }),
      }),
    )
  }
  const resize = async (columns: number, rows: number): Promise<void> => {
    stdout.columns = columns
    stdout.rows = rows
    stdout.emit('resize')
    await until(`${editorMode}: live geometry settles at ${columns}x${rows}`, () => physical.columns === columns && physical.rows === rows)
  }
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(Harness)))
  try {
    await until(`${editorMode}: real editor mounted and raw input armed`, () => insertRef.current !== null && stdin.isRaw && scrollRef.current !== null && ink.lastFrameText().length > 0)
    await until(`${editorMode}: full-height composer paints its placeholder`, () => ink.lastFrameText().includes('Type a prompt'))
    console.log(`${editorMode} initial frame\n${ink.lastFrameText()}`)
    const handle = scrollRef.current!
    insertRef.current!.setInputWithCursor('alpha beta', 5)
    await until(`${editorMode}: the held draft is painted in the editor`, () => ink.lastFrameText().includes('❯ alpha beta'))
    for (const [columns, rows, expectedCompact] of [[80, 24, true], [120, 24, true], [60, 16, true], [40, 10, true], [1, 1, true], [1, 40, true], [200, 1, true], [2, 2, true], [99, 26, true], [100, 26, false], [97, 26, false], [96, 26, true], [99, 26, true], [100, 26, false], [100, 25, true], [120, 40, false], [80, 24, true]] as const) {
      await resize(columns, rows)
      check(`${editorMode}: the renderer uses the settled latch at ${columns}x${rows}`, compact === expectedCompact, '', 'the compact or full chrome choice at this size comes from layoutChromeLive in src/screen/fullscreen-layout/useLayoutTier.ts; check its column and row thresholds and its latch')
      check(`${editorMode}: resize preserves the actual transcript handle`, scrollRef.current === handle && transcriptMounts === 1, '', 'a resize must not remount the transcript; check how src/screen/fullscreen-layout/FullscreenLayout.tsx keeps the scrollable subtree across compact and full layouts')
      check(`${editorMode}: draft and middle cursor survive ${columns}x${rows}`, pending.text() === 'alpha beta' && insertRef.current?.cursorOffset === 5, '', 'a resize must keep the draft in src/screen/composer/input-core/pending-input.ts and the cursor in src/screen/composer/Composer.tsx')
      check(`${editorMode}: local allocation is bounded by the physical terminal`, local.columns > 0 && local.columns <= columns && local.rows >= 0 && local.rows <= rows, '', 'useTerminalSize in src/screen/fullscreen-layout/useTerminalSize.ts must never report more columns or rows than useRealTerminalSize')
    }
    const beforeStorm = frames
    for (let i = 0; i < 100; i++) { stdout.columns = i % 2 === 0 ? 99 : 120; stdout.rows = 24; stdout.emit('resize') }
    await resize(83, 24)
    check(`${editorMode}: a hundred resize events coalesce instead of repainting every event`, frames - beforeStorm <= 6, `${frames - beforeStorm} composed frames`, 'resize events must be coalesced before painting; look at the resize handling in src/screen/renderer/screenInstance.tsx and useRealTerminalSize in src/screen/fullscreen-layout/useTerminalSize.ts')
    check(`${editorMode}: the storm preserves mounted state and draft`, transcriptMounts === 1 && scrollRef.current === handle && pending.text() === 'alpha beta', '', 'a burst of resize events must not remount the transcript or lose the draft; check src/screen/fullscreen-layout/FullscreenLayout.tsx and src/screen/composer/input-core/pending-input.ts')
    await resize(120, 40)
    const beforeBoundaryStorm = frames
    for (const columns of [101, 99, 97, 96, 97, 100]) { stdout.columns = columns; stdout.rows = 26; stdout.emit('resize') }
    await resize(120, 40)
    check(`${editorMode}: a boundary-crossing resize burst preserves full composition and state`, frames - beforeBoundaryStorm <= 6 && !compact && transcriptMounts === 1 && scrollRef.current === handle && pending.text() === 'alpha beta', '', 'a resize burst across the compact boundary must settle on full composition without remounting the transcript; check layoutChromeLive in src/screen/fullscreen-layout/useLayoutTier.ts and src/screen/fullscreen-layout/FullscreenLayout.tsx')
    await resize(80, 24)
    stdin.push('\u0014')
    await until(`${editorMode}: visible summary can own focus`, () => control?.read() === 'summary')
    await resize(1, 1)
    check(`${editorMode}: removing the summary row returns focus to the editor`, control?.read() === 'composer', '', 'useCompactWorkControls in src/screen/tasks/CompactWorkSummary.tsx must return focus to the composer when the summary row is no longer visible')
    stdin.push('\u0014')
    check(`${editorMode}: an invisible summary cannot take keys`, control?.read() === 'composer' && pending.text() === 'alpha beta', '', 'useCompactWorkControls in src/screen/tasks/CompactWorkSummary.tsx must refuse focus while the summary row is not visible')
    await resize(80, 24)
    handle.scrollTo(40)
    await until(`${editorMode}: transcript scrolls away before opening detail`, () => handle.getScrollTop() === 40 && !handle.isSticky())
    stdin.push('\u0014\r')
    await until(`${editorMode}: same-chunk focus and Enter open detail without submitting`, () => control?.read() === 'detail' && ink.lastFrameText().includes('Session statistics'))
    check(`${editorMode}: detail did not submit or repin`, sent.length === 0 && pending.text() === 'alpha beta' && !handle.isSticky(), '', 'opening the detail with the summary key then Enter in one chunk must not submit the draft or repin the transcript; check src/screen/composer/Composer.tsx and src/screen/tasks/CompactWorkSummary.tsx')
    await resize(1, 1)
    check(`${editorMode}: detail retains semantic ownership without a body row`, control?.read() === 'detail', '', 'useCompactWorkControls in src/screen/tasks/CompactWorkSummary.tsx must keep focus on the detail dialog when the terminal shrinks')
    stdin.push('\u001b[27uZ')
    await until(`${editorMode}: first text after tiny detail closes lands once at the retained cursor`, () => pending.text() === 'alphaZ beta')
    await resize(80, 24)
    stdin.push('\u0014xy')
    await until(`${editorMode}: summary type-to-edit handles all atoms in the same chunk`, () => pending.text() === 'alphaZxy beta')
    stdin.push('\u0014\u001b[200~\r\nA\tB\u001b[201~')
    await until(`${editorMode}: the real paste path finishes and paints`, () => (pending.text().includes('Pasted text') || pending.text().includes('A    B')) && (ink.lastFrameText().includes('Pasted text') || ink.lastFrameText().includes('A    B')) && !ink.lastFrameText().includes('pasting text'))
    check(`${editorMode}: paste never submitted`, sent.length === 0, '', 'a bracketed paste must be inserted by src/screen/composer/Composer.tsx without calling onSubmit')
    const pasted = pending.text()
    stdin.push('\u001f')
    await until(`${editorMode}: undo restores the pre-paste document`, () => pending.text() === 'alphaZxy beta' && ink.lastFrameText().includes('❯ alphaZxy beta'))
    stdin.push('\u0018\u0012')
    await until(`${editorMode}: redo restores the exact paste document`, () => pending.text() === pasted && (ink.lastFrameText().includes('Pasted text') || ink.lastFrameText().includes('A    B')))
    console.log(`${editorMode} redo state ${JSON.stringify({ text: pending.text(), expected: pasted, stash: pending.stashedPrompt() })}`)
    stdin.push('\u0013')
    await until(`${editorMode}: stash clears only the editor`, () => pending.text() === '' && pending.stashedPrompt()?.text === pasted)
    await resize(1, 1)
    await resize(80, 24)
    stdin.push('\u0013')
    await until(`${editorMode}: stash restores the exact document after resizing`, () => pending.text() === pasted && pending.stashedPrompt() === undefined)
    insertRef.current!.setInputWithCursor('prepaint ', 9)
    await until(`${editorMode}: the timed-paste baseline is painted`, () => ink.lastFrameText().includes('❯ prepaint'))
    let undoScheduled = false
    let prepaintObserved = false
    const unlistenPaste = pending.subscribePendingInput(() => {
      if (undoScheduled || pending.text() !== 'prepaint pasted') return
      undoScheduled = true
      setTimeout(() => {
        prepaintObserved = !ink.lastFrameText().includes('prepaint pasted')
        stdin.push('\u001f')
      }, 0)
    })
    stdin.push('\u001b[200~pasted\u001b[201~')
    await until(`${editorMode}: next-macrotask undo restores the pre-paste document`, () => undoScheduled && pending.text() === 'prepaint ')
    unlistenPaste()
    stdin.push('\u0018\u0012')
    await until(`${editorMode}: next-macrotask redo restores the paste exactly`, () => pending.text() === 'prepaint pasted')
    console.log(`${editorMode} next-macrotask paste history ${JSON.stringify({ prepaintObserved, text: pending.text() })}`)
    insertRef.current!.setInputWithCursor('prepaint ', 9)
    await until(`${editorMode}: the check-phase baseline is painted`, () => ink.lastFrameText().includes('❯ prepaint') && !ink.lastFrameText().includes('prepaint pasted'))
    let checkPhaseObserved = false
    let checkPhaseUndoPushed = false
    const pollUndo = (): void => {
      if (pending.text() === 'prepaint pasted') {
        checkPhaseObserved = !ink.lastFrameText().includes('prepaint pasted')
        checkPhaseUndoPushed = true
        stdin.push('\u001f')
        return
      }
      setImmediate(pollUndo)
    }
    setImmediate(pollUndo)
    stdin.push('\u001b[200~pasted\u001b[201~')
    await until(`${editorMode}: check-phase undo restores the pre-paste document`, () => checkPhaseUndoPushed && pending.text() === 'prepaint ')
    stdin.push('\u0018\u0012')
    await until(`${editorMode}: check-phase redo restores the paste exactly`, () => pending.text() === 'prepaint pasted')
    console.log(`${editorMode} check-phase paste history ${JSON.stringify({ checkPhaseObserved, text: pending.text() })}`)
    insertRef.current!.setInputWithCursor('send once', 9)
    await until(`${editorMode}: final draft is current`, () => ink.lastFrameText().includes('send once'))
    stdin.push('\r\r')
    await until(`${editorMode}: ordinary composer Enter submits`, () => sent.length > 0)
    check(`${editorMode}: repeated Enter in one dispatch sends once`, sent.length === 1 && sent[0] === 'send once', JSON.stringify(sent), 'two Enter keys in one dispatch must call onSubmit once; check the submit path in src/screen/composer/Composer.tsx and pending.clearForSubmit in src/screen/composer/input-core/pending-input.ts')
  } finally {
    console.log(`${editorMode} final frame\n${ink.lastFrameText()}`)
    ink.unmount()
    await ink.waitUntilExit()
    instances.delete(stdout as never)
  }
}
console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error/.test(line)), faults.join('\n'), 'a render fault or hook-order error was logged to console.error during the run; read the logged line above and fix the component it names')
console.log(`compact-resize-rig: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
