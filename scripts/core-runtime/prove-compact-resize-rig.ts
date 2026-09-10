#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
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
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { BackgroundTasksDialog } = await import('../../src/components/tasks/BackgroundTasksDialog.tsx')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/hooks/useGlobalKeybindings.tsx')
const { useLayoutChrome } = await import('../../src/context/layoutChromeContext.tsx')
const { useTerminalSize, useRealTerminalSize } = await import('../../src/hooks/useTerminalSize.ts')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const h = React.createElement
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
async function until(label: string, predicate: () => boolean): Promise<void> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, 5000)
  while (!predicate() && !expired) await new Promise<void>(resolve => setImmediate(resolve))
  clearTimeout(timer)
  check(label, predicate())
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
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output()
  const stdin = new Input()
  let frames = 0
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false, onFrame: () => { frames++ } })
  instances.set(stdout as never, ink)
  const scrollRef = React.createRef<import('../../src/ink/components/ScrollBox.tsx').ScrollBoxHandle>()
  const insertRef = { current: null } as React.MutableRefObject<import('../../src/components/PromptInput/PromptInput.tsx').PromptInputProps['insertTextRef']['current']>
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
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
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
      check(`${editorMode}: the renderer uses the settled latch at ${columns}x${rows}`, compact === expectedCompact)
      check(`${editorMode}: resize preserves the actual transcript handle`, scrollRef.current === handle && transcriptMounts === 1)
      check(`${editorMode}: draft and middle cursor survive ${columns}x${rows}`, pending.text() === 'alpha beta' && insertRef.current?.cursorOffset === 5)
      check(`${editorMode}: local allocation is bounded by the physical terminal`, local.columns > 0 && local.columns <= columns && local.rows >= 0 && local.rows <= rows)
    }
    const beforeStorm = frames
    for (let i = 0; i < 100; i++) { stdout.columns = i % 2 === 0 ? 99 : 120; stdout.rows = 24; stdout.emit('resize') }
    await resize(83, 24)
    check(`${editorMode}: a hundred resize events coalesce instead of repainting every event`, frames - beforeStorm <= 6, `${frames - beforeStorm} composed frames`)
    check(`${editorMode}: the storm preserves mounted state and draft`, transcriptMounts === 1 && scrollRef.current === handle && pending.text() === 'alpha beta')
    await resize(80, 24)
    stdin.push('\u0014')
    await until(`${editorMode}: visible summary can own focus`, () => control?.read() === 'summary')
    await resize(1, 1)
    check(`${editorMode}: removing the summary row returns focus to the editor`, control?.read() === 'composer')
    stdin.push('\u0014')
    check(`${editorMode}: an invisible summary cannot take keys`, control?.read() === 'composer' && pending.text() === 'alpha beta')
    await resize(80, 24)
    handle.scrollTo(40)
    await until(`${editorMode}: transcript scrolls away before opening detail`, () => handle.getScrollTop() === 40 && !handle.isSticky())
    stdin.push('\u0014\r')
    await until(`${editorMode}: same-chunk focus and Enter open detail without submitting`, () => control?.read() === 'detail' && ink.lastFrameText().includes('Session statistics'))
    check(`${editorMode}: detail did not submit or repin`, sent.length === 0 && pending.text() === 'alpha beta' && !handle.isSticky())
    await resize(1, 1)
    check(`${editorMode}: detail retains semantic ownership without a body row`, control?.read() === 'detail')
    stdin.push('\u001b[27uZ')
    await until(`${editorMode}: first text after tiny detail closes lands once at the retained cursor`, () => pending.text() === 'alphaZ beta')
    await resize(80, 24)
    stdin.push('\u0014xy')
    await until(`${editorMode}: summary type-to-edit handles all atoms in the same chunk`, () => pending.text() === 'alphaZxy beta')
    stdin.push('\u0014\u001b[200~\r\nA\tB\u001b[201~')
    await until(`${editorMode}: the real paste path finishes and paints`, () => (pending.text().includes('Pasted text') || pending.text().includes('A    B')) && (ink.lastFrameText().includes('Pasted text') || ink.lastFrameText().includes('A    B')) && !ink.lastFrameText().includes('pasting text'))
    check(`${editorMode}: paste never submitted`, sent.length === 0)
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
    insertRef.current!.setInputWithCursor('send once', 9)
    await until(`${editorMode}: final draft is current`, () => ink.lastFrameText().includes('send once'))
    stdin.push('\r\r')
    await until(`${editorMode}: ordinary composer Enter submits`, () => sent.length > 0)
    check(`${editorMode}: repeated Enter in one dispatch sends once`, sent.length === 1 && sent[0] === 'send once', JSON.stringify(sent))
  } finally {
    console.log(`${editorMode} final frame\n${ink.lastFrameText()}`)
    ink.unmount()
    await ink.waitUntilExit()
    instances.delete(stdout as never)
  }
}
console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error/.test(line)), faults.join('\n'))
const source = readFileSync(join(import.meta.dir, '../../src/components/BaseTextInput.tsx'), 'utf8')
check('the input routing precedes the production paste wrapper', source.indexOf('props.routeInput?.') >= 0 && source.indexOf('props.routeInput?.') < source.indexOf('wrappedOnInput(input, key, event)'))
console.log(`compact-resize-rig: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
