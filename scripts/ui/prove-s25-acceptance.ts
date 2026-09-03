#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-s25-acceptance.ts — the S25 "acceptance
//  checks with no existing oracle", as one prover, following the lane idiom
//  (S31/S32): pure importable surfaces are exercised BEHAVIOURALLY
//  in-process; hook/render semantics (no in-process ink render harness
//  exists) are pinned STRUCTURALLY on the rewritten sources. The rendered
//  behaviour itself is covered by the parcel's real-TUI captures.
//
//  Coverage map:
//  · behavioural: 6 (colouriser arms), 60 (navigability rows), 63 (primary
//    table + Tmux args), 64 (copy extraction + reminder strip), 78 (tree
//    building via the rendered component's exported pure pieces is internal
//    — pinned structurally), 81 (statusline stub predicate/helper), option
//    map structure (8-basis), agent source display names.
//  · structural pins: theme provider (1–5), primitives' precedence + alias
//    asymmetry (6), kernel key grammar and viewport laws (8–30), chrome
//    (31–41), transcript/sticky (42–59), cursor-mode wiring (61–62), diff
//    cache + fallback (65–68), surface behaviours (69–84 remainder).
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'

import OptionMap, {
  isInputOption,
  optionValueOf,
} from '../../src/components/CustomSelect/option-map.js'
import { color, isRawColorValue, resolveThemeColor } from '../../src/components/design-system/color.js'
import {
  copyTextOf,
  isNavigableMessage,
  MESSAGE_ACTIONS,
  stripSystemReminders,
  toolCallOf,
} from '../../src/components/messageActions.js'
import { getAgentSourceDisplayName } from '../../src/components/agents/utils.js'
import { getTheme } from '../../src/utils/theme.js'

let passCount = 0
let failCount = 0
function check(name: string, condition: boolean): void {
  if (condition) {
    passCount++
    console.log(`  [PASS] ${name}`)
  } else {
    failCount++
    console.log(`  [FAIL] ${name}`)
  }
}

const SRC = join(import.meta.dir, '../../src')
function sourceOf(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}
function pin(name: string, rel: string, needles: string[]): void {
  const text = sourceOf(rel)
  const missing = needles.filter(needle => !text.includes(needle))
  check(`${name} [structural: ${rel}]`, missing.length === 0)
  for (const needle of missing) console.log(`         missing: ${needle}`)
}

console.log('S25 §7.2 acceptance battery')

// ── colour resolution (6, partial 1) ───────────────────────────────────────
{
  for (const raw of ['rgb(1, 2, 3)', '#aabbcc', 'ansi256(41)', 'ansi:red']) {
    check(`raw form recognized: ${raw}`, isRawColorValue(raw))
  }
  check('role name is not a raw form', !isRawColorValue('brand'))
  const dark = getTheme('dark')
  check('resolveThemeColor raw bypasses lookup', resolveThemeColor(dark, '#123456') === '#123456')
  check('resolveThemeColor role resolves', resolveThemeColor(dark, 'brand') === dark.brand)
  check('resolveThemeColor unknown role → nothing, no throw', resolveThemeColor(dark, 'not-a-role') === undefined)
  check('resolveThemeColor empty → nothing', resolveThemeColor(dark, '') === undefined)
  check('color() undefined returns text unchanged', color(undefined, 'dark')('x') === 'x')
  const painted = color('brand', 'dark')('x')
  check('color() role paints (or degrades to identity under NO_COLOR)', typeof painted === 'string' && painted.includes('x'))
  // The alias map is a TEXT-primitive input surface; the colouriser must
  // not apply it: a legacy spelling is an unknown role here.
  check('color() does NOT apply the legacy alias map', color('claude', 'dark')('x') === 'x' || !color('claude', 'dark')('x').includes('[38;'))
}

// ── the option map (kernel basis) ──────────────────────────────────────────
{
  const options = [
    { label: 'a', value: 'a' },
    { label: 'b', value: 'b', disabled: true },
    { type: 'input' as const, label: 'c', value: 'c' },
  ]
  const map = new OptionMap(options)
  check('option map size', map.size === 3)
  check('first/last exposed', map.first?.value === 'a' && map.last?.value === 'c')
  check('doubly linked forward', map.first?.next?.value === 'b' && map.first?.next?.next?.value === 'c')
  check('doubly linked backward', map.last?.previous?.value === 'b')
  check('absolute indices', map.get('b')?.index === 1)
  check('disabled flag carried', map.get('b')?.disabled === true)
  check('isInputOption discriminates', isInputOption(options[2]) && !isInputOption(options[0]))
  check('optionValueOf reads the pinned value', optionValueOf(options[1]) === 'b')
}

// ── system-reminder strip (64, contract tags) ──────────────────────────────
{
  check('strip: zero blocks', stripSystemReminders('  hello') === 'hello')
  check(
    'strip: one block',
    stripSystemReminders('<system-reminder>x</system-reminder>  hi') === 'hi',
  )
  check(
    'strip: several blocks',
    stripSystemReminders(
      ' <system-reminder>a</system-reminder> <system-reminder>b</system-reminder>ok',
    ) === 'ok',
  )
  const unterminated = '<system-reminder>never closed... hello'
  check('strip: unterminated block stops', stripSystemReminders(unterminated) === unterminated)
}

// ── navigability rows (60) ─────────────────────────────────────────────────
{
  const user = (over: Record<string, unknown> = {}, text = 'a prompt') =>
    ({
      type: 'user',
      uuid: 'u1',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'text', text }] },
      ...over,
    }) as never
  check('user: plain prompt navigable', isNavigableMessage(user()))
  check('user: meta excluded', !isNavigableMessage(user({ isMeta: true })))
  check('user: compact summary excluded', !isNavigableMessage(user({ isCompactSummary: true })))
  check(
    'user: XML-wrapped excluded after strip',
    !isNavigableMessage(user({}, '<system-reminder>r</system-reminder><local-command-stdout>x')),
  )
  check(
    'user: reminder-prefixed real prompt navigable',
    isNavigableMessage(user({}, '<system-reminder>r</system-reminder>hello')),
  )
  const assistant = (block: unknown) =>
    ({
      type: 'assistant',
      uuid: 'a1',
      timestamp: 't',
      message: { role: 'assistant', content: [block] },
    }) as never
  check('assistant: text navigable', isNavigableMessage(assistant({ type: 'text', text: 'hi' })))
  check('assistant: empty text excluded', !isNavigableMessage(assistant({ type: 'text', text: '' })))
  check(
    'assistant: primary-table tool call navigable',
    isNavigableMessage(assistant({ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'x' })),
  )
  check(
    'assistant: off-table tool call excluded',
    !isNavigableMessage(assistant({ type: 'tool_use', name: 'SomethingElse', input: {}, id: 'x' })),
  )
  const system = (subtype: string) =>
    ({ type: 'system', subtype, uuid: 's1', timestamp: 't', content: 'x', level: 'info' }) as never
  for (const subtype of [
    'api_metrics',
    'stop_hook_summary',
    'turn_duration',
    'memory_saved',
    'agents_killed',
    'away_summary',
    'thinking',
  ]) {
    check(`system: ${subtype} excluded`, !isNavigableMessage(system(subtype)))
  }
  check('system: other subtype navigable', isNavigableMessage(system('informational')))
  check('turn receipt excluded', !isNavigableMessage({ type: 'turn_receipt', uuid: 'r', counts: {} } as never))
  const attachment = (type: string) =>
    ({ type: 'attachment', uuid: 'at', timestamp: 't', attachment: { type } }) as never
  for (const type of ['queued_command', 'diagnostics', 'hook_blocking_error', 'hook_error_during_execution']) {
    check(`attachment: ${type} navigable`, isNavigableMessage(attachment(type)))
  }
  check('attachment: other type excluded', !isNavigableMessage(attachment('taste_recall')))
  check(
    'grouped tool use navigable',
    isNavigableMessage({ type: 'grouped_tool_use', toolName: 'Read', messages: [], results: [], uuid: 'g' } as never),
  )
}

// ── the primary-input table + tool-call extraction (63) ───────────────────
{
  const toolMsg = (name: string, input: unknown) =>
    ({
      type: 'assistant',
      uuid: 'a2',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'tool_use', name, input, id: 'x' }] },
    }) as never
  check('toolCallOf reads the first block', toolCallOf(toolMsg('Read', { file_path: '/x' }))?.name === 'Read')
  check(
    'copy of a Bash call is its command',
    copyTextOf(toolMsg('Bash', { command: 'echo hi' })) === 'echo hi',
  )
  check(
    'Tmux renders its args array as a command string',
    copyTextOf(toolMsg('Tmux', { args: ['ls', '-la'] })) === 'tmux ls -la',
  )
  check(
    'non-string primary value yields nothing',
    copyTextOf(toolMsg('Read', { file_path: 42 })) === '',
  )
  const pAction = MESSAGE_ACTIONS.find(a => a.key === 'p')
  check('p action exists for grouped/assistant', Boolean(pAction) && pAction!.types.includes('assistant'))
  check(
    'p applicability requires a primary-table tool',
    pAction!.isApplicable!({ uuid: 'x', type: 'assistant', expanded: false, toolName: 'Read' }) === true &&
      pAction!.isApplicable!({ uuid: 'x', type: 'assistant', expanded: false, toolName: 'Nope' }) === false,
  )
  const enterRows = MESSAGE_ACTIONS.filter(a => a.key === 'enter')
  check('enter has an expand row and an edit row', enterRows.length === 2)
  const cAction = MESSAGE_ACTIONS.find(a => a.key === 'c')
  check('c applies to every navigable type', cAction!.types.length === 7)
}

// ── copy extraction rows (64) ──────────────────────────────────────────────
{
  const result = (content: unknown) =>
    ({
      type: 'user',
      uuid: 'u2',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'tool_result', content, tool_use_id: 'x' }] },
    }) as never
  const grouped = {
    type: 'grouped_tool_use',
    toolName: 'Read',
    messages: [],
    results: [result('first'), result(''), result([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])],
    uuid: 'g2',
  } as never
  check('grouped copy joins non-blank results by blank lines', copyTextOf(grouped) === 'first\n\na\nb')
  check(
    'system copy prefers content',
    copyTextOf({ type: 'system', subtype: 's', content: 'body', uuid: 'x' } as never) === 'body',
  )
  check(
    'system copy falls back to subtype',
    copyTextOf({ type: 'system', subtype: 'just-subtype', uuid: 'x' } as never) === 'just-subtype',
  )
  check('turn receipt copies empty', copyTextOf({ type: 'turn_receipt', uuid: 'x', counts: {} } as never) === '')
  check(
    'queued command copies its prompt text',
    copyTextOf({
      type: 'attachment',
      uuid: 'x',
      timestamp: 't',
      attachment: { type: 'queued_command', prompt: 'run it' },
    } as never) === 'run it',
  )
  check(
    'other attachment copies a bracketed type label',
    copyTextOf({
      type: 'attachment',
      uuid: 'x',
      timestamp: 't',
      attachment: { type: 'diagnostics' },
    } as never) === '[diagnostics]',
  )
  check(
    'user copy strips leading reminders',
    copyTextOf({
      type: 'user',
      uuid: 'x',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>r</system-reminder>real' }] },
    } as never) === 'real',
  )
}

// (statusline-stub section retired — the stub itself was deleted
// at the §8 drop-dead ruling; its exports do not exist to test.)

// ── agent source display names ─────────────────────────────────────────────
{
  check('all → plural agents label', getAgentSourceDisplayName('all').toLowerCase().includes('agents'))
  check('built-in label', getAgentSourceDisplayName('built-in').toLowerCase().includes('built-in'))
  check('extension label', getAgentSourceDisplayName('extension').toLowerCase().includes('extension'))
  check(
    'settings source → capitalized display name',
    getAgentSourceDisplayName('userSettings') === 'User settings',
  )
}

// ── structural pins (hook/render semantics without a render harness) ───────

pin('theme pin flag + member gate (2)', 'components/design-system/ThemeProvider.tsx', [
  "flagEnv('MERCURY_THEME_PIN')",
  '(THEME_SETTINGS as readonly string[]).includes(pin)',
  'getGlobalConfig().theme',
])
pin('no-provider default: the default appearance (its one owner), inert setters (1)', 'components/design-system/ThemeProvider.tsx', [
  'resolvedTheme: DEFAULT_THEME_SETTING',
  'themeSetting: DEFAULT_THEME_SETTING',
])
pin('ground sync on every resolved value (5)', 'components/design-system/ThemeProvider.tsx', [
  'syncOasisBgToTheme(resolvedTheme)',
  '}, [resolvedTheme])',
])
pin('auto re-seed on apply and preview (3)', 'components/design-system/ThemeProvider.tsx', [
  "if (setting === 'auto') setSystemTheme(getSystemThemeName())",
])
pin('text primitive: hover>dim>explicit + alias map (6, §8-1/2)', 'components/design-system/ThemedText.tsx', [
  'if (!color && hoverColor) {',
  '} else if (dimColor) {',
  'theme.inactive',
  "claudeBlue_FOR_SYSTEM_SPINNER: 'systemSpinner'",
  "briefLabelClaude: 'briefLabelAssistant'",
])
pin('box primitive: no alias map, event props declared (6)', 'components/design-system/ThemedBox.tsx', [
  'resolveThemeColor',
  'onClick',
  'onMouseEnter',
])
pin('accent-epoch subscription on both primitives (7)', 'components/design-system/ThemedText.tsx', [
  'useSessionAccent()',
])
pin('kernel: wrap + window laws (8–12)', 'components/CustomSelect/use-select-navigation.ts', [
  'visibleFromIndex: 0,',
  'Math.max(next.index + 1, state.visibleToIndex + 1)',
  'Math.max(0, size - visibleOptionCount)',
  'Math.min(previous.index, state.visibleFromIndex - 1)',
])
pin('kernel: asymmetric initial clamp (11)', 'components/CustomSelect/use-select-navigation.ts', [
  'Math.max(0, Math.min(from, options.length - 1))',
  'Math.min(options.length, Math.max(to, visible))',
])
pin('kernel: deep-inequality reset + truthy mount seed (13, §8-7)', 'components/CustomSelect/use-select-navigation.ts', [
  '!isEqual(previousOptionsRef.current, options)',
  'initialFocusValue: focusValue ? focusValue : initialFocusValue,',
])
pin('kernel: validated focus fallback (14)', 'components/CustomSelect/use-select-navigation.ts', [
  'focusedItem ? focusedItem.value : options[0]?.value',
])
pin('grammar: digits full-list, change-only (17, 20)', 'components/CustomSelect/use-select-input.ts', [
  'normalizeFullWidthDigits(input)',
  'state.onChange?.(optionValueOf(target))',
  'parseInt(digits, 10)',
])
pin('grammar: escape one-layer top check (16)', 'components/CustomSelect/use-select-input.ts', [
  'isTopOverlayNow(token)',
  "useRegisterOverlay('select', Boolean(onCancel))",
])
pin('grammar: input rows own typing; paging never consumes (21, 23)', 'components/CustomSelect/use-select-input.ts', [
  'if (state.isInInput) {',
  'trySeedComposer(input, key)',
  'if (key.pageDown) state.focusNextPage()',
])
pin('select: hideIndexes upgrades to numeric (19)', 'components/CustomSelect/select.tsx', [
  "const ordinalsHidden = layout === 'expanded' || hideIndexes",
  "disableSelection === false && ordinalsHidden ? 'numeric' : disableSelection",
])
pin('select: expanded-only click, disabled suppressed (24)', 'components/CustomSelect/select.tsx', [
  "layout === 'expanded' && disableSelection !== true && !option.disabled",
])
pin('multi: overlay unconditional + full raw grammar (25–28)', 'components/CustomSelect/use-multi-select-state.ts', [
  "useRegisterOverlay('multi-select')",
  "(input === 'j' && !key.ctrl && !key.shift)",
  'if (hideIndexes) return',
  'key.escape',
])
pin('input row: index always rendered, +2 cells (29, §8-10)', 'components/CustomSelect/select-input-option.tsx', [
  'reservedIndexWidth + 2',
  'INPUT_WRAP_COLUMNS = 80',
])
pin('list row: band + cursor declaration (31–32)', 'components/design-system/ListItem.tsx', [
  'tokens.selectionBand',
  'useDeclaredCursor',
  'declareCursor',
])
pin('pane fork: modal plain vs rounded card (33)', 'components/design-system/Pane.tsx', [
  'useIsInsideModal()',
  "borderStyle=\"round\"",
])
pin('dialog: cancel-active gate + press-again line (34–35)', 'components/design-system/Dialog.tsx', [
  'isActive: isCancelActive',
  'exitState.pending',
  'useElevatedSurface',
])
pin('divider: floors at zero + display width (37)', 'components/design-system/Divider.tsx', [
  'Math.max(0, total - titleWidth)',
  'stringWidth(stripAnsi(title))',
])
pin('progress bar: nine-step ramp + exact width (38)', 'components/design-system/ProgressBar.tsx', [
  "['", // the ramp array
  'Math.floor(fraction * 9)',
  'Math.min(1, Math.max(0, ratio))',
])
pin('ratchet: monotonic minimum + row cap (39)', 'components/design-system/Ratchet.tsx', [
  'Math.min(height, rowsRef.current)',
  'capped > current ? capped : current',
])
pin('tabs: wraparound + inverse only on header focus (40–41)', 'components/design-system/Tabs.tsx', [
  '(selectedIndex + delta + tabs.length) % tabs.length',
  'inverse={isSelected && headerFocused}',
  'registerNavOptIn',
])
// The key law moved out of the list into virtualListKeys.ts (the stacked-
// copies fix): the list binds the reconciler; the reconciler keeps the array's
// identity on a pure append and re-derives the moved suffix otherwise.
pin('transcript: incremental keys (42)', 'components/VirtualMessageList.tsx', [
  'reconcileItemKeys(keysStateRef.current, messages, itemKey)',
])
pin('transcript: incremental keys — the one key-law owner (42)', 'components/virtualListKeys.ts', [
  'priorRows[i] === row) continue',
  'keys.push(key)',
  'if (keys === prior.keys) {',
])
pin('transcript: sticky publication laws (53–57)', 'components/VirtualMessageList.tsx', [
  'handle.isSticky()',
  'getItemTop(i) + 1',
  'STICKY_TEXT_CAP',
  "suppressionRef.current = 'bypass'",
  'lastPublishedIndexRef.current === promptIndex',
])
pin('transcript: search engine laws (44–52)', 'components/VirtualMessageList.tsx', [
  'PHANTOM_LIMIT = 20',
  'MOUNT_ATTEMPT_LIMIT = 3',
  'JUMP_HEADROOM_ROWS = 3',
  'WARM_CHUNK = 500',
  'engine.queuedStep = direction',
])
pin('transcript: blank-cell click + single hover owner (58–59)', 'components/VirtualMessageList.tsx', [
  'event.cellIsBlank',
  'claimHover',
  'useHoverOwned',
])
pin('cursor mode: collapse-then-exit vs one-press ctrl+C (62)', 'components/messageActions.tsx', [
  "'messageActions:escape'",
  "'messageActions:ctrlc'",
  'expanded: false',
])
pin('diff: total fallback + cache clear at four (65–67)', 'components/StructuredDiff.tsx', [
  'HUNK_CACHE_LIMIT = 4',
  'StructuredDiffFallback',
  'logError(error)',
  'gutterWidth > 0 && gutterWidth < width',
])
pin('theme picker: preview release on every unmount (71)', 'components/ThemePicker.tsx', [
  'cancelPreviewRef.current()',
])
pin('thinking toggle: confirm mid-conversation (73)', 'components/ThinkingToggle.tsx', [
  'isMidConversation && next !== currentValue',
  "'confirm:yes'",
])
pin('token warning: suppression + error role (74, B8)', 'components/TokenWarning.tsx', [
  'useCompactWarningSuppression',
  "level === 'ok' || suppressed",
  'color="error"',
])
pin('task list: budget + priority + 30s recency (75)', 'components/TaskListV2.tsx', [
  'rows <= 10 ? 0 : Math.min(10, Math.max(3, rows - 14))',
  'RECENT_COMPLETION_MS = 30_000',
  '[...recent, ...inProgress, ...pending, ...older]',
  'columns >= 60',
])
pin('tag tabs: cap + off-by-two render budget (77, §8-11)', 'components/TagTabs.tsx', [
  'Math.max(20, Math.floor(budget / 2))',
  'cap - 2 - 3',
])
pin('validation list: forced objects + numeric-tail value (78)', 'components/ValidationErrorsList.tsx', [
  '/^\\d+$/.test(last)',
  'Array.isArray(existing)',
  'localeCompare',
])
pin('worktree dialog: silent path + option values (79–80)', 'components/WorktreeExitDialog.tsx', [
  'changedFiles === 0 && commits === 0',
  "'keep-kill-tmux'",
  "'remove-with-tmux'",
  'void keepTheWorktree(hasTmux ? ',
])
// /stats REMOVED ENTIRELY (operator ruling, item B — the
// inherited novelty-voice stats screen; the /usage meters are the usage
// surface). Its two acceptance pins (69, 70) retire with the surface.
pin('tool selector: continue-all + headers skipped (83)', 'components/agents/ToolSelector.tsx', [
  'selection.length === candidates.length ? undefined : selection',
  "!isSelectable(items[next]!)",
  'filterToolsForAgent',
])
pin('agent drafting: unguarded span parse + three-field throw (84)', 'components/agents/generateAgent.ts', [
  "text.indexOf('{')",
  "text.lastIndexOf('}')",
  '!record.identifier || !record.whenToUse || !record.systemPrompt',
  "querySource: 'agent_creation'",
])

console.log('')
console.log(`S25 acceptance battery: ${passCount} pass · ${failCount} fail`)
if (failCount > 0) process.exit(1)
console.log('ALL S25 ACCEPTANCE CHECKS PASS')
