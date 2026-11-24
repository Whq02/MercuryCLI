#!/usr/bin/env bun
import { join } from 'node:path'
import React from 'react'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('declared-keys-unshadowed')
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const h = React.createElement
const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, hasCompletedOnboarding: true, theme: 'dark' }))

const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.ts')
const { parseBindings } = await import('../../src/screen/keys/parser.ts')
const manifest = await import('../../src/screen/concourse/controlManifest.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { Select } = await import('../../src/screen/select/Select.tsx')
const { Dialog } = await import('../../src/screen/theme/Dialog.tsx')
const { InterruptKeys } = await import('../../src/screen/chat/interruptKeys.ts')
const { registerShellRun } = await import('../../src/tools/shell/backgroundRequest.ts')
const pendingInput = await import('../../src/screen/composer/input-core/pending-input.ts')
const { ExtensionsBoard } = await import('../../src/screen/extensions/ExtensionsBoard.tsx')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const mountWithKeys = (child: React.ReactElement, cols = 120, rows = 30) =>
  mountOffscreen(
    h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, child)),
    cols,
    rows,
  )

type Rule = {
  reason: string
  shown?: () => Promise<string[]>
}

const CAPTURE_RULES: Record<string, Rule> = {
  Settings: {
    reason: 'k/j/space/r are bound, and text fields live under this context through Select and settings hosts',
  },
  Confirmation: {
    reason: 'y/n are bound; the design-system Dialog keeps its cancel behind isCancelActive so a host with a text field turns it off while the field has focus',
    shown: async () => {
      const miss: string[] = []
      let cancels = 0
      const inactive = await mountWithKeys(h(Dialog, { title: 'Confirm', onCancel: () => { cancels++ }, isCancelActive: false }))
      try {
        await settle(80)
        inactive.push('n')
        await settle(80)
        if (cancels !== 0) miss.push(`n cancelled Dialog while isCancelActive=false (${cancels})`)
      } finally {
        inactive.unmount()
      }
      const active = await mountWithKeys(h(Dialog, { title: 'Confirm', onCancel: () => { cancels++ }, isCancelActive: true }))
      try {
        await settle(80)
        active.push('n')
        await waitFor(() => cancels === 1, 1500)
        if (cancels !== 1) miss.push(`n did not cancel Dialog while isCancelActive=true (${cancels})`)
      } finally {
        active.unmount()
      }
      return miss
    },
  },
  Chat: {
    reason: 'shift+b is bound while a shell command runs; the handler yields whenever the composer holds a draft and stands down when no shell runs',
    shown: async () => {
      const miss: string[] = []
      let bgCalls = 0
      const stopRun = registerShellRun({ agentId: undefined, request: () => { bgCalls++ } })
      const view = await mountWithKeys(
        h(InterruptKeys, {
          screen: 'prompt',
          focusedTurnActive: true,
          isInputDialogFocused: false,
          isLocalJSXCommand: false,
          isSearchingHistory: false,
          isHelpOpen: false,
          isRewindPickerVisible: false,
        }),
      )
      try {
        await settle(80)
        pendingInput.edit('draft text')
        view.push('B')
        await settle(80)
        if (bgCalls !== 0) miss.push(`shift+b backgrounded shell while composer held a draft (${bgCalls})`)
        pendingInput.edit('')
        view.push('B')
        await waitFor(() => bgCalls === 1, 1500)
        if (bgCalls !== 1) miss.push(`shift+b did not background running shell when composer was empty (${bgCalls})`)
        const beforeStop = bgCalls
        stopRun()
        await settle(80)
        view.push('B')
        await settle(80)
        if (bgCalls !== beforeStop) miss.push(`shift+b fired after shell stopped (${bgCalls})`)
      } finally {
        pendingInput.resetPendingInputForTests()
        stopRun()
        view.unmount()
      }
      return miss
    },
  },
  Transcript: {
    reason: 'q is bound; the pager owns q / g G n N raw and stands every one down while the search bar captures, and the bar replaces the hints row while open',
    shown: async () => {
      const { openTranscriptPart } = await import('./chatScenarios.ts')
      const view = await openTranscriptPart('declared-keys-transcript')
      const miss: string[] = []
      await view.setRows(view.rowsOf(3))
      await view.act(() => {
        view.part.value().handleEnterTranscript()
        view.part.value().setScreen('transcript')
      })
      await view.press('/')
      await waitFor(() => view.jumps.includes('query ""'), 2000)
      for (const letter of 'qg/') await view.press(letter, 40)
      if (view.part.value().screen !== 'transcript') miss.push('q left the transcript while the search bar was open')
      if (!view.jumps.includes('query "qg/"')) miss.push(`q, g and / were not typed into the query: ${view.jumps.slice(-3).join(',')}`)
      if (view.scroll.calls.length > 0) miss.push(`g scrolled while the search bar was open: ${view.scroll.calls.join(',')}`)
      await view.press(KEY.esc)
      await view.press('g')
      if (view.scroll.calls.join() !== 'scrollTo 0') miss.push(`g does not go to the top once the bar is closed: ${view.scroll.calls.join(',')}`)
      await view.press('q')
      if (view.part.value().screen !== 'prompt') miss.push('q does not leave the transcript once the bar is closed')
      await view.close()
      process.chdir(ROOT)
      return miss
    },
  },
  MessageSelector: {
    reason: 'k/j are bound on the pick phase and inactive off the pick phase',
  },
  MessageActions: {
    reason: 'the message-actions menu hosts no text field',
  },
  DiffDialog: {
    reason: 'n/p/c/o/a/f/r/s/x are bound and inactive while the comment composer is open',
  },
  Select: {
    reason: 'k/j/space are bound; the engine drops navigation and accept while the focused option is a text input (only cancel stays, on escape)',
    shown: async () => {
      const miss: string[] = []
      let focused = 'alpha'
      let typed = ''
      let cancels = 0
      const view = await mountWithKeys(
        h(Select<string>, {
          options: [
            { label: 'Alpha', value: 'alpha' },
            {
              type: 'input',
              label: 'Custom',
              value: 'custom',
              placeholder: 'type here',
              initialValue: '',
              onChange: value => {
                typed = value
              },
            },
            { label: 'Beta', value: 'beta' },
          ],
          onFocus: value => {
            focused = value
          },
          onCancel: () => {
            cancels++
          },
        }),
      )
      try {
        await settle(80)
        view.push('j')
        await waitFor(() => focused === 'custom', 1500)
        if (focused !== 'custom') miss.push(`j did not move focus to input option (focused=${focused})`)
        for (const ch of 'jk ') {
          view.push(ch)
          await settle(40)
        }
        if (focused !== 'custom') miss.push(`j/k/space moved focus out of input option (focused=${focused})`)
        if (typed !== 'jk ') miss.push(`j/k/space were not typed into input option (typed=${JSON.stringify(typed)})`)
        view.push(KEY.esc)
        await waitFor(() => cancels === 1, 1500)
        if (cancels !== 1) miss.push(`esc did not cancel Select from input option (cancels=${cancels})`)
      } finally {
        view.unmount()
      }
      return miss
    },
  },
  Extensions: {
    reason: 'the board letters are bound; the add/filter slot owns input, the board keys stand down while it does, and NavigablePanes swaps the footer to the slot',
    shown: async () => {
      const miss: string[] = []
      let closed = 0
      const view = await mountWithKeys(
        h(ExtensionsBoard, {
          route: { kind: 'board', section: 'installed' },
          onClose: () => {
            closed++
          },
          appendTranscript: () => {},
        }),
        140,
        30,
      )
      try {
        await settle(120)
        view.push('a')
        const opened = await waitFor(() => view.screen().includes('esc composer'), 2000)
        if (!opened) miss.push('pressing a did not open the add slot with the esc composer footer')
        for (const ch of 'fai') {
          view.push(ch)
          await settle(40)
        }
        if (!view.screen().includes('fai')) miss.push('board letters f/a/i were not typed into the add slot')
        if (!view.screen().includes('esc composer')) miss.push('board letters f/a/i disturbed the add slot')
        if (closed !== 0) miss.push(`board closed while typing in add slot (${closed})`)
        view.push(KEY.esc)
        const left = await waitFor(() => !view.screen().includes('esc composer'), 2000)
        if (!left) miss.push('esc did not close the add slot')
      } finally {
        view.unmount()
      }
      return miss
    },
  },
}

section('§1 the registry — every context that binds a bare printable declares its capture rule')
{
  const bindings = parseBindings(DEFAULT_BINDINGS)
  const bound = new Map<string, Set<string>>()
  for (const b of bindings) {
    if (b.action === null || b.chord.length !== 1) continue
    const k = b.chord[0]!
    if (k.ctrl || k.meta || k.alt || k.super || k.key.length !== 1) continue
    if (!bound.has(b.context)) bound.set(b.context, new Set())
    bound.get(b.context)!.add(`${k.shift ? 'shift+' : ''}${k.key === ' ' ? 'space' : k.key}`)
  }
  const undeclared = [...bound.keys()].filter(c => !(c in CAPTURE_RULES))
  check('every context that binds a bare printable has a capture rule', undeclared.length === 0, `${undeclared.join(', ')} · add a capture rule for each listed context to CAPTURE_RULES in this file, or remove its bare printable binding from src/screen/keys/defaultBindings.ts`)
  const stale = Object.keys(CAPTURE_RULES).filter(c => !bound.has(c))
  check('the table names no context without a bare printable', stale.length === 0, `${stale.join(', ')} · delete these contexts from CAPTURE_RULES in this file, or restore their bare printable binding in src/screen/keys/defaultBindings.ts`)
  check('the census is populated (≥ 8 contexts bind bare printables)', bound.size >= 8, `${bound.size} · parseBindings(DEFAULT_BINDINGS) in src/screen/keys/parser.ts and src/screen/keys/defaultBindings.ts yielded too few contexts with bare printable keys`)
  for (const [ctx, rule] of Object.entries(CAPTURE_RULES)) {
    const keys = [...(bound.get(ctx) ?? [])].join(' ')
    if (rule.shown !== undefined) {
      const miss = await rule.shown()
      check(`${ctx} (${keys}): bare keys stand down while a field captures, shown by the mounted component`, miss.length === 0, `${miss.join(' · ')} · the component for ${ctx} must stop handling its bare keys while a text field has focus; see its key handler or the isActive flag of its keybinding hook`)
    }
  }
}
section('§3 the Session Concourse board — the rows own their letters in every state (pure)')
{
  const { regionKeysFor, newSessionTabLabel, helpKeyFiresFor } = manifest
  const classes = ['live', 'paused', 'attached', 'queued', 'parked', 'stopped', 'door', 'none'] as const
  const isLetterVerb = (keys: string): boolean => /^[a-z\/]$/.test(keys) || keys === 'space'
  const shadowed: string[] = []
  for (const selection of classes) {
    const plain = regionKeysFor('list', { newSession: true, selection })
    const armed = new Set(regionKeysFor('list', { newSession: true, selection, armed: true }).map(k => k.keys))
    const held = new Set(regionKeysFor('list', { newSession: true, selection, liveDraftHeld: true }).map(k => k.keys))
    for (const k of plain.map(r => r.keys).filter(isLetterVerb)) {
      if (!armed.has(k)) shadowed.push(`${selection}/armed/${k}`)
      if (!held.has(k)) shadowed.push(`${selection}/draft/${k}`)
    }
  }
  check('no list letter verb disappears under the arm or a held draft (the legend never advertises a key typing would eat)', shadowed.length === 0, `${shadowed.join(' · ')} · regionKeysFor in src/screen/concourse/controlManifest.ts must keep these list letter verbs when armed or when liveDraftHeld is set`)
  check("no 'type to message' row exists in any list state", classes.every(s => !regionKeysFor('list', { newSession: true, selection: s, armed: true }).some(k => k.keys === 'type')), 'regionKeysFor in src/screen/concourse/controlManifest.ts returned a type row for a list state; remove it')
  check("the header's n prints on the rows only, never under the filter or the composer", newSessionTabLabel({ region: 'list', filtering: false }) === '+ new session · n' && newSessionTabLabel({ region: 'list', filtering: true }) === '+ new session' && newSessionTabLabel({ region: 'live', filtering: false }) === '+ new session', 'newSessionTabLabel in src/screen/concourse/controlManifest.ts must append · n only for the list region without a filter')
  check('the atlas key follows the focused composer’s draft', helpKeyFiresFor('list', false) && helpKeyFiresFor('live', true) && !helpKeyFiresFor('live', false), 'helpKeyFiresFor in src/screen/concourse/controlManifest.ts must fire for the list region with no draft and for the live region only with a draft')
}

await releaseScratchHome(HOME)
console.log(failures === 0 ? '\nprove-declared-keys-unshadowed: EVERY DECLARED KEY STANDS' : `\nprove-declared-keys-unshadowed: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
