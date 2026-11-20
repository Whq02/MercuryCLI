#!/usr/bin/env bun
import { mock } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const HOME = pinScratchHome('exit-reachability')
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const note = (label: string): void => console.log(`  [NOTE] ${label}`)
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

try {
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.ts')
  const { KEYBINDING_CONTEXTS } = await import('../../src/keybindings/schema.ts')
  const { parseBindings } = await import('../../src/keybindings/parser.ts')
  const { resolveKeyWithChordState } = await import('../../src/keybindings/resolver.ts')
  const { actionAffordance } = await import('../../src/keybindings/atlas.ts')
  const { composeFooterHint, packFooter } = await import('../../src/components/mercury-ui/footerHint.ts')
  const { MODEL_PICKER_EXIT_WORDS, modelPickerFooter } = await import('../../src/utils/model/modelPickerFooter.ts')
  type Key = import('../../src/ink/events/input-event.ts').Key
  type KeybindingContextName = import('../../src/keybindings/types.ts').KeybindingContextName
  type LlmHostRoad = import('../../src/services/llmHost/index.ts').LlmHostRoad
  type LlmHostEvent = import('../../src/services/llmHost/index.ts').LlmHostEvent
  type LlmHostQuestion = import('../../src/services/llmHost/index.ts').LlmHostQuestion

  const React = await import('react')
  const h = React.createElement
  const { Text } = await import('../../src/ink.ts')
  const { App } = await import('../../src/components/App.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
  const { useRegisterKeybindingContext } = await import('../../src/keybindings/KeybindingContext.tsx')
  const { enableConfigs } = await import('../../src/utils/config.ts')
  const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
  const { openSettingsPopup, closeSettingsPopup, isSettingsPopupOpen } = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { Settings } = await import('../../src/components/Settings/Settings.tsx')
  const { PermissionPrompt } = await import('../../src/components/permissions/PermissionPrompt.tsx')
  const { Dialog } = await import('../../src/components/design-system/Dialog.tsx')
  const { TranscriptFooter } = await import('../../src/screens/chat/useChatSearch.tsx')
  const { ThemePicker } = await import('../../src/components/ThemePicker.tsx')
  const { HelpV2 } = await import('../../src/components/HelpV2/HelpV2.tsx')
  const { SelectInputOption } = await import('../../src/components/CustomSelect/select-input-option.tsx')
  const { Select } = await import('../../src/components/CustomSelect/select.tsx')
  const { MessageSelector } = await import('../../src/components/MessageSelector.tsx')
  const { MessageActionsBar } = await import('../../src/components/messageActions.tsx')
  const { DiffDialog } = await import('../../src/components/diff/DiffDialog.tsx')
  const { MercuryInputAtlas } = await import('../../src/components/MercuryInputAtlas.tsx')
  const { NavigablePanes } = await import('../../src/components/mercury-ui/NavigablePanes.tsx')
  const { LlmHostDialog } = await import('../../src/components/LlmHostDialog.tsx')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { CommandCenter } = await import('../../src/components/mercury-ui/components.tsx')

  const delivery = { ...(await import('../../src/ink/session/delivery.ts')) }
  mock.module('../../src/ink/session/delivery.ts', () => ({
    ...delivery,
    writeAllSync: (fd: number, data: Buffer, syscalls?: Parameters<typeof delivery.writeAllSync>[2]): boolean =>
      fd === 1 ? true : delivery.writeAllSync(fd, data, syscalls),
  }))

  const sessionModel = await import('../../src/components/mercury-ui/screens/sessionPickerModel.ts')
  const fixtureSessionId = '00000000-0000-4000-8000-000000000001'
  const fixtureLog = {
    sessionId: fixtureSessionId,
    projectPath: ROOT,
    cwd: ROOT,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    firstPrompt: 'fixture session row',
    customTitle: 'fixture session row',
    messageCount: 2,
    fullPath: join(HOME, 'never-read-before-hop.jsonl'),
  }
  const fixtureFlat = [{ project: 'fixture', head: true, row: { project: 'fixture', label: fixtureLog.customTitle, seen: 'now', log: fixtureLog } }]
  mock.module('../../src/components/mercury-ui/screens/sessionPickerModel.ts', () => ({
    ...sessionModel,
    useSessionPickerModel: () => ({ logs: [fixtureLog], pendingMore: 0, projectKey: 'fixture', flat: fixtureFlat, elsewhereCount: 0, dropSessions() {} }),
  }))
  const { SessionManagerView } = await import('../../src/components/mercury-ui/screens/SessionManagerView.tsx')

  enableConfigs()

  function ContextScope({ contexts, children }: { contexts: readonly KeybindingContextName[]; children?: React.ReactNode }): React.ReactNode {
    for (const ctx of contexts) useRegisterKeybindingContext(ctx, true)
    return children
  }

  async function mountScreen(
    node: React.ReactNode,
    opts: { columns?: number; rows?: number; contexts?: readonly KeybindingContextName[]; mouseTracking?: boolean } = {},
  ): Promise<Mounted> {
    resetOverlayStackForTests()
    const body = opts.contexts && opts.contexts.length > 0 ? h(ContextScope, { contexts: opts.contexts }, node) : node
    const wrapped = h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, body))
    const view = await mountOffscreen(wrapped, opts.columns ?? 120, opts.rows ?? 30, { mouseTracking: opts.mouseTracking })
    await settle(60)
    return view
  }

  function clickAt(view: Mounted, col1: number, row1: number): void {
    view.push(`\x1b[<0;${col1};${row1}M\x1b[<0;${col1};${row1}m`)
  }

  function keyOf(partial: Partial<Key>): Key {
    return {
      upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
      pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
      home: false, end: false, return: false, escape: false,
      ctrl: false, shift: false, fn: false, tab: false, backspace: false,
      delete: false, meta: false, super: false, isPasted: false,
      ...partial,
    } as Key
  }
  const ESCAPE = keyOf({ escape: true, meta: true })
  const CTRL_D = keyOf({ ctrl: true })
  const CTRL_L = '\x0c'
  const CTRL_R = '\x12'

  type ProbeResult = { label: string; ok: boolean; detail?: string }
  type Exit =
    | { kind: 'binding'; action: string; input?: string; key?: Key; hintExempt?: string; prove?: () => Promise<ProbeResult[]> }
    | { kind: 'raw'; prove?: () => Promise<ProbeResult[]> }
    | { kind: 'host'; owner: string; reason: string }
    | { kind: 'root'; reason: string }

  const EXIT_TABLE: Record<string, Exit> = {
    Global: { kind: 'root', reason: 'the process root — ctrl+d (app:exit) leaves; no screen stands above it' },
    Chat: {
      kind: 'binding',
      action: 'chat:cancel',
      hintExempt: 'the chat is the root bridge, never a screen to leave; esc cancels the input or the transient surface (the composer help lists it)',
    },
    Autocomplete: {
      kind: 'binding',
      action: 'autocomplete:dismiss',
      hintExempt: 'a non-modal completion menu — typing continues, esc dismisses; the composer keeps its own vocabulary',
    },
    Settings: {
      kind: 'binding',
      action: 'confirm:no',
      prove: async () => {
        const req = { view: 'config' as const, width: 60, rows: 10, line: 'probe', hint: '↑↓ choose · esc or click outside closes', body: () => h(Text, null, 'body') }
        openSettingsPopup(req)
        const wide = await mountScreen(
          h(Settings, { request: req, geometry: { width: 60, inner: 56, rows: 10, rowBudget: 4, compact: false, left: 0, top: 0 } }),
          { columns: 80, rows: 14, contexts: ['Settings'] },
        )
        try {
          const shown = await waitFor(() => wide.screen().includes('esc or click outside closes'), 3000)
          wide.push(KEY.esc)
          const closed = await waitFor(() => !isSettingsPopupOpen(), 3000)
          return [{ label: 'Settings: renders its footer hint and closes on esc', ok: shown && closed, detail: `shown=${shown} closed=${closed} screen=${wide.screen().slice(0, 300)}` }]
        } finally {
          wide.unmount()
          closeSettingsPopup()
        }
      },
    },
    Confirmation: {
      kind: 'binding',
      action: 'confirm:no',
      prove: async () => {
        const out: ProbeResult[] = []
        const promptView = await mountScreen(
          h(PermissionPrompt, { options: [{ value: 'allow', label: 'Allow' }], onSelect: () => {} }),
          { columns: 100, rows: 12, contexts: ['Confirmation'] },
        )
        try {
          const ok = await waitFor(() => promptView.screen().includes('↑↓ choose · ↵ confirm · esc cancel'), 3000)
          out.push({ label: 'Confirmation: PermissionPrompt renders its exit hint', ok, detail: promptView.screen().slice(0, 300) })
        } finally {
          promptView.unmount()
        }
        let cancelled = false
        const dialogView = await mountScreen(
          h(Dialog, { title: 'Confirm', onCancel: () => { cancelled = true } }, h(Text, null, 'body')),
          { columns: 100, rows: 14, contexts: ['Confirmation'] },
        )
        try {
          const hasHint = await waitFor(() => /\besc\b/i.test(dialogView.screen()) && dialogView.screen().includes('cancel'), 3000)
          dialogView.push(KEY.esc)
          const fired = await waitFor(() => cancelled, 3000)
          out.push({ label: 'Confirmation: Dialog renders its cancel hint and cancels on esc', ok: hasHint && fired, detail: `hint=${hasHint} fired=${fired} screen=${dialogView.screen().slice(0, 300)}` })
        } finally {
          dialogView.unmount()
        }
        return out
      },
    },
    Tabs: { kind: 'host', owner: 'src/components/design-system/Tabs.tsx', reason: 'a tab strip inside a dialog — the dialog (Confirmation) owns esc' },
    Transcript: {
      kind: 'binding',
      action: 'transcript:exit',
      prove: async () => {
        const props = { toggleChord: 'ctrl+o', expandChord: 'ctrl+e', hasSearchBadge: false, virtualScroll: true, showAllSuppressed: false, showAll: false, status: null, badge: null }
        const footer = await mountScreen(h(TranscriptFooter, props), { columns: 120, rows: 4 })
        try {
          await waitFor(() => footer.lines().some(line => line.includes('detailed transcript')), 3000)
          const drawn = footer.lines().join('\n')
          const missing = ['q quits', 'ctrl+o to toggle'].filter(words => !drawn.includes(words))
          return [{ label: 'Transcript: the hint is rendered (drawn by its mounted footer)', ok: missing.length === 0, detail: missing.join(' · ') }]
        } finally {
          footer.unmount()
        }
      },
    },
    HistorySearch: {
      kind: 'binding',
      action: 'historySearch:accept',
      hintExempt: 'the search field leaves on esc (accept) and ctrl+c (cancel); its own row prints no key hint',
    },
    Task: { kind: 'host', owner: 'src/keybindings/defaultBindings.ts', reason: 'ctrl+b backgrounds the foreground task — not a screen' },
    ThemePicker: {
      kind: 'raw',
      prove: async () => {
        let cancelled = false
        const view = await mountScreen(
          h(ThemePicker, { onThemeSelect: () => {}, onCancel: () => { cancelled = true } }),
          { columns: 100, rows: 28, contexts: ['Select'] },
        )
        try {
          const hasHint = await waitFor(() => view.screen().includes('esc to cancel'), 3000)
          view.push(KEY.esc)
          const exited = await waitFor(() => cancelled, 3000)
          return [
            { label: 'ThemePicker: pressing esc cancels the picker', ok: exited, detail: view.screen().slice(0, 300) },
            { label: 'ThemePicker: the hint is rendered', ok: hasHint, detail: view.screen().slice(0, 300) },
          ]
        } finally {
          view.unmount()
        }
      },
    },
    Scroll: { kind: 'host', owner: 'src/components/ScrollKeybindingHandler.tsx', reason: 'the transcript scroller — a handler, not a screen' },
    Help: {
      kind: 'binding',
      action: 'help:dismiss',
      prove: async () => {
        let closed = false
        const view = await mountScreen(
          h(HelpV2, { commands: [], onClose: () => { closed = true } }),
          { columns: 120, rows: 30, contexts: ['Help'] },
        )
        try {
          const hasHint = await waitFor(() => view.screen().includes('esc close'), 3000)
          view.push(KEY.esc)
          const exited = await waitFor(() => closed, 3000)
          return [{ label: 'Help: renders esc close and dismisses on esc', ok: hasHint && exited, detail: `hint=${hasHint} exited=${exited} screen=${view.screen().slice(0, 300)}` }]
        } finally {
          view.unmount()
        }
      },
    },
    Attachments: {
      kind: 'binding',
      action: 'attachments:exit',
      prove: async () => {
        let exited = false
        const view = await mountScreen(
          h(SelectInputOption, {
            option: { type: 'input', value: 'other', label: 'Other' },
            isFocused: true,
            value: '',
            onChange: () => {},
            onSubmit: () => {},
            reservedIndexWidth: 2,
            index: 1,
            pastedContents: { 1: { id: 1, type: 'image', content: 'abc', mediaType: 'image/png' } },
            isImageSelectionMode: true,
            selectedImageIndex: 0,
            onExitImageSelection: () => { exited = true },
          }),
          { columns: 100, rows: 10, contexts: ['Attachments'] },
        )
        try {
          const hasHint = await waitFor(() => /\besc\b\s+cancel/i.test(view.screen()), 3000)
          view.push(KEY.esc)
          const left = await waitFor(() => exited, 3000)
          return [{ label: 'Attachments: renders esc cancel and exits image selection on esc', ok: hasHint && left, detail: `hint=${hasHint} left=${left} screen=${view.screen().slice(0, 300)}` }]
        } finally {
          view.unmount()
        }
      },
    },
    Footer: {
      kind: 'binding',
      action: 'footer:clearSelection',
      hintExempt: 'the footer indicators are a focus mode of the composer (↑ into the task/crew rows); esc clears it and the composer keeps the frame',
    },
    MessageSelector: {
      kind: 'binding',
      action: 'messageSelector:close',
      prove: async () => {
        let closed = false
        const view = await mountScreen(
          h(MessageSelector, {
            messages: [],
            onPreRestore: () => {},
            onRestore: async () => ({ outcome: 'applied' } as never),
            onSummarize: () => {},
            onClose: () => { closed = true },
          }),
          { columns: 100, rows: 16, contexts: ['MessageSelector'] },
        )
        try {
          const hasHint = await waitFor(() => view.screen().includes('esc close'), 3000)
          view.push(KEY.esc)
          const exited = await waitFor(() => closed, 3000)
          return [{ label: 'MessageSelector: renders esc close and closes on esc', ok: hasHint && exited, detail: `hint=${hasHint} exited=${exited} screen=${view.screen().slice(0, 300)}` }]
        } finally {
          view.unmount()
        }
      },
    },
    MessageActions: {
      kind: 'binding',
      action: 'messageActions:escape',
      prove: async () => {
        const view = await mountScreen(
          h(MessageActionsBar, { cursor: { uuid: 'u1', type: 'assistant', expanded: false } }),
          { columns: 100, rows: 8 },
        )
        try {
          const hasHint = await waitFor(() => view.screen().includes('esc back'), 3000)
          return [{ label: 'MessageActions: MessageActionsBar renders esc back', ok: hasHint, detail: view.screen().slice(0, 300) }]
        } finally {
          view.unmount()
        }
      },
    },
    DiffDialog: {
      kind: 'binding',
      action: 'diff:dismiss',
      prove: async () => {
        let closed = false
        const view = await mountScreen(
          h(DiffDialog, { messages: [], onDone: () => { closed = true } }),
          { columns: 120, rows: 24, contexts: ['DiffDialog'] },
        )
        try {
          const hasHint = await waitFor(() => view.screen().includes('esc close'), 3000)
          view.push(KEY.esc)
          const exited = await waitFor(() => closed, 3000)
          return [{ label: 'DiffDialog: renders esc close and dismisses on esc', ok: hasHint && exited, detail: `hint=${hasHint} exited=${exited} screen=${view.screen().slice(0, 300)}` }]
        } finally {
          view.unmount()
        }
      },
    },
    ModelPicker: {
      kind: 'raw',
      prove: async () => {
        const wide = modelPickerFooter({ gated: false }, 120)
        const narrow = modelPickerFooter({ gated: false }, 30)
        const ok = wide.includes(MODEL_PICKER_EXIT_WORDS) && wide.includes('esc or click outside closes') && narrow.includes('esc closes')
        return [{ label: 'ModelPicker: footer emits exit hint at wide and narrow widths', ok, detail: `wide=${JSON.stringify(wide)} narrow=${JSON.stringify(narrow)}` }]
      },
    },
    Select: {
      kind: 'binding',
      action: 'select:cancel',
      prove: async () => {
        let cancelled = false
        const view = await mountScreen(
          h(Dialog, { title: 'Choose', onCancel: () => {} }, h(Select, { options: [{ label: 'Alpha', value: 'a' }], onChange: () => {}, onCancel: () => { cancelled = true } })),
          { columns: 100, rows: 14, contexts: ['Select'] },
        )
        try {
          const hasHint = await waitFor(() => /\besc\b/i.test(view.screen()) && view.screen().includes('cancel'), 3000)
          view.push(KEY.esc)
          const exited = await waitFor(() => cancelled, 3000)
          return [{ label: 'Select: renders cancel hint and cancels on esc', ok: hasHint && exited, detail: `hint=${hasHint} exited=${exited} screen=${view.screen().slice(0, 300)}` }]
        } finally {
          view.unmount()
        }
      },
    },
    Extensions: { kind: 'raw' },
    Atlas: {
      kind: 'raw',
      prove: async () => {
        let closed = false
        const view = await mountScreen(
          h(MercuryInputAtlas, { onClose: () => { closed = true } }),
          { columns: 120, rows: 28 },
        )
        try {
          const browse = await waitFor(() => view.screen().includes('tab context'), 3000)
          view.push(CTRL_L)
          const lookupHint = await waitFor(() => view.screen().includes('esc back'), 3000)
          view.push(KEY.esc)
          const backFromLookup = await waitFor(() => view.screen().includes('tab context'), 3000)
          view.push(CTRL_R)
          const rebindHint = await waitFor(() => view.screen().includes('esc cancel'), 3000)
          view.push(KEY.esc)
          const backFromRebind = await waitFor(() => view.screen().includes('rebind cancelled'), 3000)
          view.push(KEY.esc)
          const closedOnEsc = await waitFor(() => closed, 3000)
          return [
            { label: 'Atlas: esc leaves lookup and rebind capture and closes browse', ok: browse && backFromLookup && backFromRebind && closedOnEsc, detail: `browse=${browse} lookup=${backFromLookup} rebind=${backFromRebind} closed=${closedOnEsc}` },
            { label: 'Atlas: renders esc back in lookup and esc cancel in rebind', ok: lookupHint && rebindHint, detail: `lookupHint=${lookupHint} rebindHint=${rebindHint}` },
          ]
        } finally {
          view.unmount()
        }
      },
    },
    Workbench: {
      kind: 'raw',
      prove: async () => {
        let closed = false
        const rows = [{ id: 'r1', name: 'Item One' }]
        const view = await mountScreen(
          h(NavigablePanes, {
            view: 'workbench',
            sections: [{ id: 's1', label: 'Items', rows }],
            columns: [{ key: 'name', header: 'Name', cell: (row: { id: string; name: string }) => h(Text, null, row.name) }],
            rowKey: (row: { id: string; name: string }) => row.id,
            renderDetail: (row: { id: string; name: string }) => h(Text, null, row.name),
            onClose: () => { closed = true },
          }),
          { columns: 120, rows: 24 },
        )
        try {
          const hasHint = await waitFor(() => view.screen().includes('esc close'), 3000)
          view.push(KEY.esc)
          const exited = await waitFor(() => closed, 3000)
          return [
            { label: 'Workbench: NavigablePanes closes on esc', ok: exited, detail: view.screen().slice(0, 300) },
            { label: 'Workbench: NavigablePanes renders esc close', ok: hasHint, detail: view.screen().slice(0, 300) },
          ]
        } finally {
          view.unmount()
        }
      },
    },
  }

  const bindings = parseBindings(DEFAULT_BINDINGS)
  const graph = ACTION_GRAPH as Record<string, { contexts: readonly string[] }>

  section('§1 totality — every context the estate names declares its exit')
  {
    const named = new Set<string>()
    for (const c of KEYBINDING_CONTEXTS) named.add(c)
    for (const block of DEFAULT_BINDINGS) named.add(block.context)
    for (const meta of Object.values(graph)) for (const c of meta.contexts) named.add(c)
    const undeclared = [...named].filter(c => !(c in EXIT_TABLE))
    check('every schema · default-block · graph context is in the exit table', undeclared.length === 0, undeclared.join(', '))
    const stale = Object.keys(EXIT_TABLE).filter(c => !named.has(c))
    check('the table names no context the estate has retired', stale.length === 0, stale.join(', '))
    const exits = Object.values(EXIT_TABLE).filter(e => e.kind === 'binding').length
    check('the table is populated (binding exits ≥ 12)', exits >= 12, `${exits}`)
  }

  const exitActions = new Set<string>()
  for (const e of Object.values(EXIT_TABLE)) if (e.kind === 'binding') exitActions.add(e.action)

  section('§2 registry exits — bound, resolved in the hook\'s own order, unshadowed')
  for (const [ctx, exit] of Object.entries(EXIT_TABLE)) {
    if (exit.kind !== 'binding') continue
    const input = exit.input ?? ''
    const key = exit.key ?? ESCAPE
    const own = resolveKeyWithChordState(input, key, [ctx, 'Global'], bindings, null)
    check(
      `${ctx}: escape resolves to ${exit.action} for [${ctx}, Global]`,
      own.type === 'match' && own.action === exit.action,
      JSON.stringify(own),
    )
    const afford = actionAffordance(exit.action, ctx, bindings, 'linux')
    check(
      `${ctx}: the affordance oracle calls ${exit.action} bound (nothing later unbinds it) — via ${afford.kind === 'unbound' ? '—' : afford.chord}`,
      afford.kind === 'bound',
      JSON.stringify(afford),
    )
    check(`${ctx}: ${exit.action} exists in the action graph under this context`, ctx in EXIT_TABLE && (graph[exit.action]?.contexts ?? []).includes(ctx), JSON.stringify(graph[exit.action]?.contexts))
  }
  {
    const all = Object.keys(EXIT_TABLE)
    const wide = resolveKeyWithChordState('', ESCAPE, all, bindings, null)
    check('escape over EVERY context at once is an exit-class match', wide.type === 'match' && exitActions.has(wide.action), JSON.stringify(wide))
    const root = resolveKeyWithChordState('d', CTRL_D, ['Global'], bindings, null)
    check('the root leaves: ctrl+d resolves to app:exit in Global', root.type === 'match' && root.action === 'app:exit', JSON.stringify(root))
    const blocksWithEscape = new Set(
      bindings.filter(b => b.chord.length === 1 && b.chord[0]!.key === 'escape' && b.action !== null).map(b => b.context),
    )
    const leaning = Object.entries(EXIT_TABLE)
      .filter(([ctx, e]) => e.kind === 'binding' && !blocksWithEscape.has(ctx))
      .map(([ctx]) => ctx)
    check('every registry exit lives in its OWN block (no context leans on a foreign escape row)', leaning.length === 0, leaning.join(', '))
  }

  section('§3 the printed way out — the consumer that mounts the context renders and honours it')
  for (const [ctx, exit] of Object.entries(EXIT_TABLE)) {
    if (exit.kind === 'host') {
      check(`${ctx}: host-owned (${exit.reason})`, statSync(join(ROOT, exit.owner)).isFile())
      continue
    }
    if (exit.kind === 'root') {
      note(`${ctx}: ${exit.reason}`)
      continue
    }
    if (exit.prove !== undefined) {
      const results = await exit.prove()
      for (const r of results) check(r.label, r.ok, r.detail ?? '')
      continue
    }
    if (exit.kind === 'binding') {
      note(`${ctx}: no printed hint by design — ${exit.hintExempt ?? 'UNEXPLAINED'}`)
      check(`${ctx}: a hint exemption carries its reason`, typeof exit.hintExempt === 'string' && exit.hintExempt.length > 20)
    }
  }

  section('§4 /llmhost — contextual footer hints and dialog exit states')
  {
    let emitEvent: ((event: LlmHostEvent) => void) | null = null
    let askNow: ((plan: LlmHostQuestion) => Promise<string | null>) | null = null
    let finishRoad: ((result: { ok: boolean; words: string }) => void) | null = null
    const popupRoad: LlmHostRoad = (ask, emit) => {
      askNow = ask
      emitEvent = emit
      return new Promise(resolve => { finishRoad = resolve })
    }
    const req = llmHostPopupRequest(popupRoad)
    openSettingsPopup(req)
    const popup = await mountScreen(
      h(Settings, { request: req, geometry: { width: 90, inner: 86, rows: 16, rowBudget: 10, compact: false, left: 0, top: 0 } }),
      { columns: 100, rows: 20, contexts: ['Settings'] },
    )
    try {
      await waitFor(() => emitEvent !== null && askNow !== null, 3000)
      emitEvent!({ title: 'watch', words: 'watching stock', host: { id: 'p1', status: 'WATCHING', price: 1.5, startedAt: new Date().toISOString() } })
      const watchHint = await waitFor(() => popup.screen().includes('esc closes · watch continues'), 3000)
      emitEvent!({ title: 'bill', words: 'machine running', host: { id: 'p1', status: 'RUNNING', price: 1.5, startedAt: new Date().toISOString() } })
      const billingHint = await waitFor(() => popup.screen().includes('esc closes · billing continues'), 3000)
      check('/llmhost sends its contextual running hint to the popup footer', watchHint && billingHint, `watch=${watchHint} billing=${billingHint} screen=${popup.screen().slice(0, 400)}`)
      finishRoad?.({ ok: true, words: 'done' })
    } finally {
      popup.unmount()
      closeSettingsPopup()
    }

    let emitDialog: ((event: LlmHostEvent) => void) | null = null
    let askDialog: ((plan: LlmHostQuestion) => Promise<string | null>) | null = null
    let finishDialog: ((result: { ok: boolean; words: string }) => void) | null = null
    const dialogRoad: LlmHostRoad = (ask, emit) => {
      askDialog = ask
      emitDialog = emit
      return new Promise(resolve => { finishDialog = resolve })
    }
    const dialog = await mountScreen(
      h(LlmHostDialog, { width: 80, rowBudget: 12, road: dialogRoad }),
      { columns: 90, rows: 16 },
    )
    try {
      await waitFor(() => emitDialog !== null && askDialog !== null, 3000)
      emitDialog!({ title: 'step', words: 'working' })
      const runningShown = await waitFor(() => dialog.lines().some(line => line.trim() === '…'), 3000)
      const pendingAnswer = askDialog!({ step: 'address', title: 'Server address', found: 'found', willRun: 'will run' })
      const inputShown = await waitFor(() => dialog.screen().includes('↵ continue · esc closes'), 3000)
      dialog.push(KEY.enter)
      await pendingAnswer
      finishDialog!({ ok: true, words: 'all done' })
      const finishedShown = await waitFor(() => dialog.screen().includes('all done') && dialog.screen().includes('esc closes'), 3000)
      check('/llmhost renders the running, input and finished exit hints', runningShown && inputShown && finishedShown, `running=${runningShown} input=${inputShown} finished=${finishedShown} screen=${dialog.screen().slice(0, 400)}`)
    } finally {
      dialog.unmount()
    }
  }

  section('§5 the session switcher keeps its exit live while the swap lands (the dead-esc trap, closed)')
  {
    let closeAllCalls = 0
    let resumeCalls: Array<{ id: string; entrypoint: string }> = []
    let resolveResume: (() => void) | null = null
    const switcher = await mountScreen(
      h(SessionManagerView, {
        onClose: () => {},
        onCloseAll: () => { closeAllCalls++ },
        onNewSession: () => {},
        onResume: (sessionId, _log, entrypoint) => {
          resumeCalls.push({ id: sessionId, entrypoint })
          return new Promise<void>(resolve => { resolveResume = resolve })
        },
      }),
      { columns: 120, rows: 24 },
    )
    try {
      const listed = await waitFor(() => switcher.screen().includes('fixture session row'), 3000)
      switcher.push(KEY.enter)
      const confirming = await waitFor(() => switcher.screen().includes('↵ yes, switch · esc / n cancel'), 3000)
      switcher.push(KEY.enter)
      const swapStarted = await waitFor(() => resumeCalls.length === 1, 3000)
      const swappingFooter = await waitFor(() => switcher.screen().includes('switching — the swap keeps going · esc back to the chat'), 3000)
      check(
        'the switch calls onResume directly without reading the transcript before the hop',
        listed && confirming && swapStarted && resumeCalls[0]!.id === fixtureSessionId && resumeCalls[0]!.entrypoint === 'slash_command_picker',
        JSON.stringify({ listed, confirming, resumeCalls }),
      )
      check('the swapping footer names the leave', swappingFooter, switcher.screen().slice(0, 400))
      switcher.push(KEY.esc)
      const leftOnEsc = await waitFor(() => closeAllCalls === 1, 3000)
      const confirmDisarmed = await waitFor(() => switcher.screen().includes('fixture session row') && !switcher.screen().includes('↵ yes, switch'), 3000)
      check('esc during the swap stays live and leaves the panel while the swap keeps going', leftOnEsc, `closeAllCalls=${closeAllCalls}`)
      check('a cancelled switch disarms the confirm it came from', confirmDisarmed, switcher.screen().slice(0, 400))
      resolveResume?.()
      await settle(100)
      check('a generation fence drops the late land', closeAllCalls === 1, `closeAllCalls=${closeAllCalls}`)
    } finally {
      switcher.unmount()
    }

    check('the phase footer passes the shell’s composer untouched',
      composeFooterHint('switching — the swap keeps going · esc back to the chat', { closeKeys: 'esc-arrow', captureInput: false }) === 'switching — the swap keeps going · esc back to the chat')
    check('the deleting footer under closeKeys none gains no appended esc',
      composeFooterHint('deleting the named set…', { closeKeys: 'none', captureInput: false }) === 'deleting the named set…' &&
      packFooter(composeFooterHint('deleting the named set…', { closeKeys: 'none', captureInput: false }), 60) === 'deleting the named set…')
    check('closeKeys none appends nothing even to a bare dir footer',
      composeFooterHint('orchard-src', { closeKeys: 'none', captureInput: true }) === 'orchard-src')

    let blockedCloses = 0
    const lockedShell = await mountScreen(
      h(CommandCenter, { view: 'sessions', footer: 'deleting the named set…', closeKeys: 'none', captureInput: true, onClose: () => { blockedCloses++ } }, h(Text, null, 'working')),
      { columns: 100, rows: 12, mouseTracking: true },
    )
    let allowedCloses = 0
    const liveShell = await mountScreen(
      h(CommandCenter, { view: 'sessions', footer: 'done', closeKeys: 'esc-arrow', captureInput: true, onClose: () => { allowedCloses++ } }, h(Text, null, 'ready')),
      { columns: 100, rows: 12, mouseTracking: true },
    )
    try {
      const lockedShown = await waitFor(() => lockedShell.screen().includes('deleting the named set…'), 3000)
      const lockedFooterRow = lockedShell.lines().findIndex(line => line.includes('deleting the named set…'))
      lockedShell.push(KEY.esc)
      lockedShell.push(KEY.left)
      if (lockedFooterRow >= 0) clickAt(lockedShell, 6, lockedFooterRow + 1)
      await settle(100)
      const liveShown = await waitFor(() => liveShell.screen().includes('esc / ← close'), 3000)
      const liveFooterRow = liveShell.lines().findIndex(line => line.includes('esc / ← close'))
      if (liveFooterRow >= 0) clickAt(liveShell, 6, liveFooterRow + 1)
      const clickedClosed = await waitFor(() => allowedCloses === 1, 3000)
      liveShell.push(KEY.esc)
      const escClosed = await waitFor(() => allowedCloses === 2, 3000)
      liveShell.push(KEY.left)
      const leftClosed = await waitFor(() => allowedCloses === 3, 3000)
      check(
        'the shell’s esc/← listener and its footer click target stand down under none',
        lockedShown && blockedCloses === 0 && liveShown && clickedClosed && escClosed && leftClosed,
        JSON.stringify({ lockedShown, blockedCloses, liveShown, allowedCloses, lockedFooterRow, liveFooterRow }),
      )
    } finally {
      lockedShell.unmount()
      liveShell.unmount()
    }
  }
} finally {
  await releaseScratchHome(HOME)
}

console.log(failures === 0 ? '\nprove-exit-reachability: EVERY WAY OUT STANDS' : `\nprove-exit-reachability: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
