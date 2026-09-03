#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-exit-reachability.ts — NO SCREEN TRAPS: every context,
//  overlay, card and mode has a way out that is printed on screen and works.
//
//  The law, per input context:
//    · REGISTRY contexts: an exit-class action is bound to escape (or the
//      context's named exit chord) in the shipped defaults, the resolver
//      answers it for the hook's own resolution order ([own, Global]) — the
//      last-match rule cannot hand escape to a foreign action — the atlas's
//      affordance oracle calls it bound (nothing later unbinds it), and the
//      consumer that mounts the context prints the hint;
//    · RAW-INPUT surfaces (their own useInput): the file decodes escape (or
//      rides an engine that does — useInteractiveList, useFlatList, the
//      panes grammar, a Dialog, the CommandCenter shell) AND prints an exit
//      hint; a file that is not a surface (a primitive, a handler, a pane
//      whose host owns the keys) is on a CLOSED roster with its reason;
//    · HOST contexts (a tab strip inside a dialog, the scroller, the
//      foreground-task chord) own no screen — their host's exit is the law.
//
//  §5 pins the trap this lane closed: the session switcher's spinner phase
//  gated its whole key handler off while a footer still read 'esc close' —
//  a slow transcript read left the operator on a dead esc. Both phases keep
//  their exit live now (cancel the read · leave while the swap keeps going),
//  and a phase that genuinely owns no exit (the prune door deleting) tells
//  the shell so (closeKeys 'none') instead of wearing an appended lie.
//
//  Run: bun scripts/ui/prove-exit-reachability.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.ts')
const { KEYBINDING_CONTEXTS } = await import('../../src/keybindings/schema.ts')
const { parseBindings } = await import('../../src/keybindings/parser.ts')
const { resolveKeyWithChordState } = await import('../../src/keybindings/resolver.ts')
const { actionAffordance } = await import('../../src/keybindings/atlas.ts')
const { composeFooterHint, packFooter } = await import('../../src/components/mercury-ui/footerHint.ts')
type Key = import('../../src/ink/events/input-event.ts').Key

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const note = (label: string): void => console.log(`  [NOTE] ${label}`)
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const has = (src: string, needle: string | RegExp): boolean =>
  typeof needle === 'string' ? src.includes(needle) : needle.test(src)

/** The decoded escape keystroke as the event layer delivers it (meta rides
 *  escape — the quirk buildKeystroke corrects). */
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

// ── THE EXIT TABLE — every context's declared way out ───────────────────────
type Hint = { file: string; needles: Array<string | RegExp> }
type Exit =
  | { kind: 'binding'; action: string; input?: string; key?: Key; hints: Hint[]; hintExempt?: string }
  | { kind: 'raw'; route: Hint; hints: Hint[] }
  | { kind: 'host'; owner: string; reason: string }
  | { kind: 'root'; reason: string }

const EXIT_TABLE: Record<string, Exit> = {
  Global: { kind: 'root', reason: 'the process root — ctrl+d (app:exit) leaves; no screen stands above it' },
  Chat: {
    kind: 'binding',
    action: 'chat:cancel',
    hints: [],
    hintExempt: 'the chat is the root bridge, never a screen to leave; esc cancels the input or the transient surface (the composer help lists it)',
  },
  Autocomplete: {
    kind: 'binding',
    action: 'autocomplete:dismiss',
    hints: [],
    hintExempt: 'a non-modal completion menu — typing continues, esc dismisses; the composer keeps its own vocabulary',
  },
  Settings: {
    kind: 'binding',
    action: 'confirm:no',
    hints: [{ file: 'src/components/Settings/Config.tsx', needles: ['action="confirm:no"', 'fallback="esc"'] }],
  },
  Confirmation: {
    kind: 'binding',
    action: 'confirm:no',
    hints: [
      { file: 'src/components/permissions/PermissionPrompt.tsx', needles: ["escapeHint = 'esc cancel'", '↑↓ choose · ↵ confirm · ${escapeHint}'] },
      { file: 'src/components/design-system/Dialog.tsx', needles: ["useShortcutDisplay('confirm:no', 'Confirmation', 'esc')", '<KeyboardShortcutHint shortcut={cancelKey} action="cancel" />'] },
    ],
  },
  Tabs: { kind: 'host', owner: 'src/components/design-system/Tabs.tsx', reason: 'a tab strip inside a dialog — the dialog (Confirmation) owns esc' },
  Transcript: {
    kind: 'binding',
    action: 'transcript:exit',
    hints: [{ file: 'src/screens/REPL.tsx', needles: ["'q quits'"] }],
  },
  HistorySearch: {
    kind: 'binding',
    action: 'historySearch:accept',
    hints: [],
    hintExempt: 'the search field leaves on esc (accept) and ctrl+c (cancel); its own row prints no key hint — src/components/PromptInput/HistorySearchInput.tsx is another lane’s file (noted in §6)',
  },
  Task: { kind: 'host', owner: 'src/keybindings/defaultBindings.ts', reason: 'ctrl+b backgrounds the foreground task — not a screen' },
  ThemePicker: {
    kind: 'raw',
    route: { file: 'src/components/ThemePicker.tsx', needles: ['onCancel={() => {'] },
    hints: [{ file: 'src/components/ThemePicker.tsx', needles: ['esc to cancel'] }],
  },
  Scroll: { kind: 'host', owner: 'src/components/ScrollKeybindingHandler.tsx', reason: 'the transcript scroller — a handler, not a screen' },
  Help: {
    kind: 'binding',
    action: 'help:dismiss',
    hints: [{ file: 'src/components/HelpV2/HelpV2.tsx', needles: ['closeKeys="esc"', "useKeybinding('help:dismiss', dismiss, { context: 'Help' })"] }],
  },
  Attachments: {
    kind: 'binding',
    action: 'attachments:exit',
    hints: [{ file: 'src/components/CustomSelect/select-input-option.tsx', needles: ["useShortcutDisplay('attachments:exit', 'Attachments', 'esc')"] }],
  },
  Footer: {
    kind: 'binding',
    action: 'footer:clearSelection',
    hints: [],
    hintExempt: 'the footer indicators are a focus mode of the composer (↑ into the task/team rows); esc clears it and the composer keeps the frame',
  },
  MessageSelector: {
    kind: 'binding',
    action: 'messageSelector:close',
    hints: [{ file: 'src/components/MessageSelector.tsx', needles: ['esc to close', '↑↓ select · ↵ choose · esc close'] }],
  },
  MessageActions: {
    kind: 'binding',
    action: 'messageActions:escape',
    hints: [{ file: 'src/components/messageActions.tsx', needles: ['<Text bold>esc</Text>', '<Text dimColor> back</Text>'] }],
  },
  DiffDialog: {
    kind: 'binding',
    action: 'diff:dismiss',
    hints: [{ file: 'src/components/diff/DiffDialog.tsx', needles: ['closeKeys="esc"', "bind('diff:dismiss', closeOneLevel)"] }],
  },
  ModelPicker: {
    kind: 'raw',
    route: { file: 'src/components/MercuryModelPicker.tsx', needles: ["rowAxis === 'cancel'", 'onClose?.()'] },
    hints: [{ file: 'src/utils/model/modelPickerFooter.ts', needles: [": 'esc close'"] }],
  },
  Select: {
    kind: 'binding',
    action: 'select:cancel',
    hints: [{ file: 'src/components/design-system/Dialog.tsx', needles: ["useShortcutDisplay('confirm:no', 'Confirmation', 'esc')"] }],
  },
  Extensions: {
    kind: 'raw',
    route: { file: 'src/components/extensions/ExtensionsBoard.tsx', needles: ['const cardEsc = (card: CardSpec): void => {'] },
    hints: [{ file: 'src/components/extensions/ExtensionsBoard.tsx', needles: ['esc cancel'] }],
  },
  Atlas: {
    kind: 'raw',
    route: { file: 'src/components/MercuryInputAtlas.tsx', needles: ['if (key.escape && pending === null) {'] },
    hints: [{ file: 'src/components/MercuryInputAtlas.tsx', needles: ['esc back', 'esc cancel'] }],
  },
  Workbench: {
    kind: 'raw',
    route: { file: 'src/components/mercury-ui/NavigablePanes.tsx', needles: ['escOverride'] },
    hints: [{ file: 'src/components/mercury-ui/NavigablePanes.tsx', needles: ["closeHint ?? 'esc close'"] }],
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
  // The oracle names the action's DISPLAY chord (its last-declared row —
  // 'q' for the transcript viewer, tab for history search); what matters
  // here is the verdict: bound, never disabled or unbound.
  const afford = actionAffordance(exit.action, ctx, bindings, 'linux')
  check(
    `${ctx}: the affordance oracle calls ${exit.action} bound (nothing later unbinds it) — via ${afford.kind === 'unbound' ? '—' : afford.chord}`,
    afford.kind === 'bound',
    JSON.stringify(afford),
  )
  check(`${ctx}: ${exit.action} exists in the action graph under this context`, ctx in EXIT_TABLE && (graph[exit.action]?.contexts ?? []).includes(ctx), JSON.stringify(graph[exit.action]?.contexts))
}
{
  // The interceptor's vantage — every context at once — must still hand
  // escape to an exit-class action (the last block's), never to a foreign
  // verb and never to nothing.
  const all = Object.keys(EXIT_TABLE)
  const wide = resolveKeyWithChordState('', ESCAPE, all, bindings, null)
  check('escape over EVERY context at once is an exit-class match', wide.type === 'match' && exitActions.has(wide.action), JSON.stringify(wide))
  const root = resolveKeyWithChordState('d', CTRL_D, ['Global'], bindings, null)
  check('the root leaves: ctrl+d resolves to app:exit in Global', root.type === 'match' && root.action === 'app:exit', JSON.stringify(root))
  // A context whose block binds NO escape must be a host/root/raw entry —
  // a registry surface that leans on a foreign block for its exit is the
  // stranded class the rewind surface once was.
  const blocksWithEscape = new Set(
    bindings.filter(b => b.chord.length === 1 && b.chord[0]!.key === 'escape' && b.action !== null).map(b => b.context),
  )
  const leaning = Object.entries(EXIT_TABLE)
    .filter(([ctx, e]) => e.kind === 'binding' && !blocksWithEscape.has(ctx))
    .map(([ctx]) => ctx)
  check('every registry exit lives in its OWN block (no context leans on a foreign escape row)', leaning.length === 0, leaning.join(', '))
}

section('§3 the printed way out — the consumer that mounts the context says so')
for (const [ctx, exit] of Object.entries(EXIT_TABLE)) {
  if (exit.kind === 'host') {
    check(`${ctx}: host-owned (${exit.reason})`, statSync(join(ROOT, exit.owner)).isFile())
    continue
  }
  if (exit.kind === 'root') {
    note(`${ctx}: ${exit.reason}`)
    continue
  }
  if (exit.kind === 'raw') {
    const src = read(exit.route.file)
    const missing = exit.route.needles.filter(n => !has(src, n))
    check(`${ctx}: the surface decodes escape itself (${exit.route.file})`, missing.length === 0, missing.map(String).join(' · '))
  }
  if (exit.hints.length === 0) {
    note(`${ctx}: no printed hint by design — ${exit.hintExempt ?? 'UNEXPLAINED'}`)
    check(`${ctx}: a hint exemption carries its reason`, typeof exit.hintExempt === 'string' && exit.hintExempt.length > 20)
    continue
  }
  for (const hint of exit.hints) {
    const src = read(hint.file)
    const missing = hint.needles.filter(n => !has(src, n))
    check(`${ctx}: the hint is rendered (${hint.file})`, missing.length === 0, missing.map(String).join(' · '))
  }
}

section('§4 raw-input census — every useInput surface decodes an exit and prints it')
{
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e}`
      const st = statSync(join(ROOT, rel))
      if (st.isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) files.push(rel)
    }
  }
  for (const tree of ['src/components', 'src/screens', 'src/commands']) walk(tree)
  const inputFiles = files.filter(rel => /\buseInput\(/.test(read(rel)))
  check('the census is populated (≥ 80 raw-input files)', inputFiles.length >= 80, `${inputFiles.length}`)

  /** Code only — a comment that mentions esc is not a printed hint. */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const ROUTE_NEEDLES: RegExp[] = [
    /key\.escape/, /decodeNavKey\(/, /decodeDomNavKey\(/,
    /useInteractiveList\b/, /useFlatList\b/, /useNavigablePanes\b/, /<NavigablePanes\b/,
    /onCancel/, /'confirm:no'/, /useExitOnCtrlCD/, /'select:cancel'/,
    /:dismiss'/, /:close'/, /:exit'/, /\bescape:/, /<Dialog\b/,
  ]
  const shellOwned = (src: string): boolean => /<CommandCenter\b/.test(src) && !/captureInput=\{false\}/.test(src)
  const HINT_NEEDLES: RegExp[] = [
    /\besc\b/i, /⇧←/, /shift\+←/,
    /<CommandCenter\b/, /<Dialog\b/, /KeyboardShortcutHint/, /ConfigurableShortcutHint/, /useShortcutDisplay\(/,
    /\blegend\b/, /\bfooter\b/, /footerHints/, /modelPickerFooter\(/,
  ]
  // Files that own a useInput but are NOT a surface — the exit is their
  // host's. CLOSED: a row whose file gained its own exit (or lost its
  // useInput) is a stale row and reds here.
  const ROUTE_ROSTER: Record<string, string> = {
    'src/components/BaseTextInput.tsx': 'a text-field primitive; the hosting card or shell owns the exit',
    'src/components/ScrollKeybindingHandler.tsx': 'the scroll/selection handler — renders nothing',
    'src/components/SurfaceExitChord.tsx': 'a chord handler — renders nothing',
    'src/components/concourse/CoordinatorPane.tsx': 'a Concourse pane — ConcourseScreen owns esc for the whole board',
    'src/components/concourse/SessionMirror.tsx': 'a Concourse pane — ConcourseScreen owns esc for the whole board',
    'src/components/permissions/rules/RecentDenialsTab.tsx': 'a tab body inside the permissions dialog — the dialog owns esc',
  }
  // Files whose printed hint lives elsewhere: an engine composes hints its
  // host prints; a view whose command wrapper mounts the shell. A `witness`
  // names the file that prints — checked to carry a hint needle itself.
  const HINT_ROSTER: Record<string, { reason: string; witness?: string }> = {
    'src/components/BaseTextInput.tsx': { reason: 'a primitive; the host prints the hint' },
    'src/components/ScrollKeybindingHandler.tsx': { reason: 'renders nothing' },
    'src/components/SurfaceExitChord.tsx': { reason: 'renders nothing' },
    'src/components/concourse/CoordinatorPane.tsx': { reason: 'the board’s key atlas prints the way out', witness: 'src/components/concourse/ConcourseScreen.tsx' },
    'src/components/concourse/SessionMirror.tsx': { reason: 'the board’s key atlas prints the way out', witness: 'src/components/concourse/ConcourseScreen.tsx' },
    'src/components/permissions/rules/RecentDenialsTab.tsx': { reason: 'the permissions dialog prints the way out', witness: 'src/components/MercuryPermissionsPanel.tsx' },
    'src/components/CustomSelect/use-multi-select-state.ts': { reason: 'the Select engine; the hosting dialog prints', witness: 'src/components/design-system/Dialog.tsx' },
    'src/components/CustomSelect/use-select-input.ts': { reason: 'the Select engine; the hosting dialog prints', witness: 'src/components/design-system/Dialog.tsx' },
    'src/components/mercury-ui/useFlatList.ts': { reason: 'a list engine; its host prints the composed hints' },
    'src/components/mercury-ui/useInteractiveList.ts': { reason: 'a list engine; its host prints the composed hints' },
    'src/components/mercury-ui/useNavigablePanes.ts': { reason: 'the panes engine; NavigablePanes prints the footer', witness: 'src/components/mercury-ui/NavigablePanes.tsx' },
  }

  const routeMissing: string[] = []
  const hintMissing: string[] = []
  for (const rel of inputFiles) {
    const src = read(rel)
    const routed = ROUTE_NEEDLES.some(n => n.test(src)) || shellOwned(src)
    if (!routed && !(rel in ROUTE_ROSTER)) routeMissing.push(rel)
    const code = stripComments(src)
    const hinted = HINT_NEEDLES.some(n => n.test(code))
    if (!hinted && !(rel in HINT_ROSTER)) hintMissing.push(rel)
  }
  check('every raw-input surface decodes an exit (or is a rostered non-surface)', routeMissing.length === 0, routeMissing.join(' · '))
  check('every raw-input surface prints its way out (or is a rostered non-surface)', hintMissing.length === 0, hintMissing.join(' · '))
  const staleRoute = Object.keys(ROUTE_ROSTER).filter(rel => !inputFiles.includes(rel) || ROUTE_NEEDLES.some(n => n.test(read(rel))) || shellOwned(read(rel)))
  check('the route roster is closed and current (no stale row)', staleRoute.length === 0, staleRoute.join(' · '))
  const staleHint = Object.keys(HINT_ROSTER).filter(rel => !inputFiles.includes(rel) || HINT_NEEDLES.some(n => n.test(stripComments(read(rel)))))
  check('the hint roster is closed and current (no stale row)', staleHint.length === 0, staleHint.join(' · '))
  const blindWitness = Object.entries(HINT_ROSTER)
    .filter(([, row]) => row.witness !== undefined && !HINT_NEEDLES.some(n => n.test(stripComments(read(row.witness!)))))
    .map(([rel, row]) => `${rel} → ${row.witness}`)
  check('every roster witness prints a hint itself', blindWitness.length === 0, blindWitness.join(' · '))
}

section('§5 the session switcher keeps its exit live while the swap lands (the dead-esc trap, closed)')
{
  const view = read('src/components/mercury-ui/screens/SessionManagerView.tsx')
  check('the switch is a named phase, never a boolean that gates the handler off', view.includes("useState<'swapping' | null>(null)") && !view.includes('isActive: !switching'))
  check('esc during the swap leaves the panel while the swap keeps going', view.includes('if (key.escape) leaveSwitch()') && view.includes("if (phase === 'swapping') onCloseAll()"))
  const fences = (view.match(/if \(gen !== switchGenRef\.current\) return/g) ?? []).length
  check(`a generation fence drops the late land (1 fence, found ${fences})`, fences === 1)
  // The hop reads the log's path and title and the session's connector
  // paints the words incrementally — the whole-file parse the panel once
  // awaited before every swap ('reading the transcript…') fed nothing and
  // was the felt lag of switching; it is gone, phase and all.
  check('the switch reads no transcript before the hop (no whole-file load, no loading phase)', !view.includes('loadFullLog') && !view.includes("'loading'") && view.includes("await onResume(sessionId, log, 'slash_command_picker')"))
  check('the swapping footer names the leave', view.includes('switching — the swap keeps going · esc back to the chat'))
  check('the prune door’s deleting beat advertises no exit (closeKeys none)', view.includes("closeKeys={prune.stage === 'deleting' ? 'none' : 'esc-arrow'}") && view.includes("'deleting the named set…'"))
  check('a cancelled switch disarms the confirm it came from', /switchGenRef\.current\+\+\s*\n\s*setSwitching\(null\)\s*\n\s*setConfirmingKey\(null\)/.test(view))
  // The footer advertises its own close verb, so the shell appends
  // nothing contradictory on top (the dedup law, driven pure).
  check('the phase footer passes the shell’s composer untouched',
    composeFooterHint('switching — the swap keeps going · esc back to the chat', { closeKeys: 'esc-arrow', captureInput: false }) === 'switching — the swap keeps going · esc back to the chat')
  check('the deleting footer under closeKeys none gains no appended esc',
    composeFooterHint('deleting the named set…', { closeKeys: 'none', captureInput: false }) === 'deleting the named set…' &&
    packFooter(composeFooterHint('deleting the named set…', { closeKeys: 'none', captureInput: false }), 60) === 'deleting the named set…')
  check('closeKeys none appends nothing even to a bare dir footer',
    composeFooterHint('orchard-src', { closeKeys: 'none', captureInput: true }) === 'orchard-src')
  const shell = read('src/components/mercury-ui/components.tsx')
  check('the shell’s esc/← listener and its footer click target stand down under none',
    shell.includes("const closable = closeKeys !== 'none'") &&
    shell.includes('{ isActive: captureInput && !embedded && closable }') &&
    shell.includes('onActivate={closable ? onClose : undefined}'))
}

section('§6 notes for other owners')
{
  const hs = read('src/components/PromptInput/HistorySearchInput.tsx')
  if (!/\besc\b/i.test(hs)) note('HistorySearchInput prints no exit hint (esc accepts · ctrl+c cancels both work) — the file is owned by another lane; recorded, not failed')
}

console.log(failures === 0 ? '\nprove-exit-reachability: EVERY WAY OUT STANDS' : `\nprove-exit-reachability: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
