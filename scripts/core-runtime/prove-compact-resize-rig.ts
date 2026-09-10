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
const { saveGlobalConfig } = await import('../../src/utils/config.ts')
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const h = React.createElement
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
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
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  const scrollRef = React.createRef<import('../../src/ink/components/ScrollBox.tsx').ScrollBoxHandle>()
  const insertRef = { current: null } as React.MutableRefObject<import('../../src/components/PromptInput/PromptInput.tsx').PromptInputProps['insertTextRef']['current']>
  const sent: string[] = []
  let control: ReturnType<typeof useCompactWorkControls>['controls'] | null = null
  let physical = { columns: 0, rows: 0 }
  let local = { columns: 0, rows: 0 }
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
    useLayoutChrome()
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
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(Harness)))
  try {
    await until(`${editorMode}: real editor mounted and raw input armed`, () => insertRef.current !== null && stdin.isRaw && scrollRef.current !== null && ink.lastFrame().length > 0)
    const handle = scrollRef.current
    insertRef.current!.setInputWithCursor('alpha beta', 5)
    await until(`${editorMode}: the held draft is painted`, () => ink.lastFrame().includes('alpha beta'))
    for (const [columns, rows] of [[80, 24], [120, 24], [60, 16], [40, 10], [1, 1], [1, 40], [200, 1], [2, 2], [99, 26], [100, 26], [120, 40], [80, 24]]) {
      stdout.columns = columns!
      stdout.rows = rows!
      stdout.emit('resize')
      await until(`${editorMode}: live geometry settles at ${columns}x${rows}`, () => physical.columns === columns && physical.rows === rows)
      check(`${editorMode}: resize preserves the actual transcript handle`, scrollRef.current === handle && transcriptMounts === 1)
      check(`${editorMode}: draft and middle cursor survive ${columns}x${rows}`, pending.text() === 'alpha beta' && insertRef.current?.cursorOffset === 5)
      check(`${editorMode}: local allocation is bounded by the physical terminal`, local.columns > 0 && local.columns <= columns! && local.rows >= 0 && local.rows <= rows!)
    }
    stdin.push('\u0014\r')
    await until(`${editorMode}: same-chunk focus and Enter open detail without submitting`, () => control?.read() === 'detail' && ink.lastFrame().includes('Session statistics'))
    check(`${editorMode}: detail did not submit the draft`, sent.length === 0 && pending.text() === 'alpha beta')
    stdin.push('\u001bZ')
    await until(`${editorMode}: first text after detail close lands once at the retained cursor`, () => pending.text() === 'alphaZ beta')
    stdin.push('\u0014xy')
    await until(`${editorMode}: summary type-to-edit handles all atoms in the same chunk`, () => pending.text() === 'alphaZxy beta')
    stdin.push('\u0014\u001b[200~\r\nA\tB\u001b[201~')
    await until(`${editorMode}: the real paste path finishes`, () => pending.text().includes('Pasted text') || pending.text().includes('A    B'))
    check(`${editorMode}: paste never submitted`, sent.length === 0)
    insertRef.current!.setInputWithCursor('send once', 9)
    await until(`${editorMode}: final draft is current`, () => ink.lastFrame().includes('send once'))
    stdin.push('\r\r')
    await until(`${editorMode}: ordinary composer Enter submits`, () => sent.length > 0)
    check(`${editorMode}: repeated Enter in one dispatch sends once`, sent.length === 1 && sent[0] === 'send once', JSON.stringify(sent))
  } finally {
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
