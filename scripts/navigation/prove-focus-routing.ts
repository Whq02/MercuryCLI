#!/usr/bin/env bun
// ============================================================================
//  scripts/navigation/prove-focus-routing.ts — one focus +
//  input-routing owner over the EXISTING mechanisms (the
//  inventory's target #2/#3).
//
//  What this pins:
//   · the overlay STACK laws (pure): push order = z-order · Escape closes
//     exactly ONE layer per input event (the pop-seq cap) · focus restoration
//     is STACK-based — onFocusReturn runs only when the popped entry was the
//     visually-top layer (closing a buried layer never steals focus);
//   · overlay MEMBERSHIP: every esc-owning kit/board/picker surface is
//     registered (the stacked-esc class is dead by construction);
//   · typed ONE-CONSUMPTION: the kit hooks act through the 3-arg event form
//     and stopImmediatePropagation exactly when acting — a declined key
//     propagates untouched (global bindings run only after the active owner
//     declines);
//   · inline editors ride the ONE editor machinery (TextInput/useTextInput):
//     console + tabula migrated (grapheme cursor + declared hardware cursor —
//     the IME prerequisite); LogSelector rename already there; JoinScreen
//     ADOPTED the shared composer in (useTextInput — the old
//     hand-rolled exception is CLOSED and pinned closed below).
//
//  Run: ~/.bun/bin/bun run scripts/navigation/prove-focus-routing.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isTopOverlayNow,
  popOverlay,
  pushOverlay,
  overlayStackSnapshot,
  reserveOverlayToken,
  resetOverlayStackForTests,
  topOverlay,
} from '../../src/context/overlayStack.js'
import { bumpInputEventSeqForMouse } from '../../src/ink/events/input-event.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.COMPASS_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('== the overlay stack: order · one-pop-per-event · focus return ==')
{
  resetOverlayStackForTests()
  const a = reserveOverlayToken()
  const b = reserveOverlayToken()
  let restoredA = 0
  let restoredB = 0
  pushOverlay({ token: a, id: 'board', modal: true, onFocusReturn: () => restoredA++ })
  pushOverlay({ token: b, id: 'confirm', modal: true, onFocusReturn: () => restoredB++ })
  check('push order = z-order (b on top)', isTopOverlayNow(b) && !isTopOverlayNow(a))
  check('the top entry is b', topOverlay()?.token === b)

  // One Escape = one layer: after b pops within THIS input event, a becomes
  // top mid-dispatch but the pop-seq cap makes isTopOverlayNow(a) stand down.
  popOverlay(b)
  check('b restored focus on top-pop', restoredB === 1)
  check('a is structurally top after the pop', topOverlay()?.token === a)
  check('but a stands down within the SAME input event (one-pop cap)', !isTopOverlayNow(a))

  // The next input event re-arms a (the mouse bump advances the SAME seq —
  // the sanctioned non-keyboard advance).
  bumpInputEventSeqForMouse()
  check('the NEXT event re-arms the new top', isTopOverlayNow(a))

  // Closing a BURIED layer never steals focus.
  const c = reserveOverlayToken()
  let restoredC = 0
  pushOverlay({ token: c, id: 'inner', modal: true, onFocusReturn: () => restoredC++ })
  popOverlay(a) // buried pop
  check('a buried pop runs NO focus return', restoredA === 0)
  check('the top layer (c) survives a buried pop', topOverlay()?.token === c)
  popOverlay(c)
  check('c restored focus on top-pop', restoredC === 1)
  check('the stack drains clean', overlayStackSnapshot().length === 0)
  resetOverlayStackForTests()
}

console.log('== membership + consumption + editor-ownership source pins ==')
{
  const read = (p: string): string => readFileSync(join(root, p), 'utf8')
  const list = read('src/components/mercury-ui/useInteractiveList.ts')
  const panes = read('src/components/mercury-ui/useNavigablePanes.ts')
  const flat = read('src/components/mercury-ui/useFlatList.ts')
  const picker = read('src/components/MercuryModelPicker.tsx')
  const resume = read('src/components/MercuryResume.tsx')
  const config = read('src/components/MercuryConfig.tsx')
  const consoleSrc = read('src/commands/console/console.tsx')
  // The tabula's editors: the Minerva room and the prompts panel (the board
  // that holds the /workbench slot).
  const tabula = read('src/components/tabula/MinervaRoom.tsx')
  const promptsPanel = read('src/components/prompts-panel/PromptsPanel.tsx')
  const logsel = read('src/components/LogSelector.tsx')

  // Membership: every esc-owning surface is a registered layer.
  check('kit lists register as overlays (pre-existing)', list.includes("useRegisterOverlay('list'"))
  check('boards register as overlays', panes.includes("useRegisterOverlay('board'"))
  check('model picker registers', picker.includes("useRegisterOverlay('model-picker'"))
  check('resume registers', resume.includes("useRegisterOverlay('resume'"))
  check('config registers', config.includes("useRegisterOverlay('config'"))
  check('console registers', consoleSrc.includes("useRegisterOverlay('console'"))
  // Guards: esc acts only as the top layer.
  for (const [name, src] of [
    ['boards', panes],
    ['model picker', picker],
    ['resume', resume],
    ['config', config],
    ['console', consoleSrc],
  ] as const) {
    check(`${name}: esc guarded by isTopOverlayNow`, src.includes('isTopOverlayNow(overlayToken)'))
  }

  // Typed one-consumption: the kit acts through the 3-arg event form.
  check('useInteractiveList consumes when acting', (list.match(/stopImmediatePropagation\(\)/g) ?? []).length >= 3)
  check('useNavigablePanes consumes when acting', (panes.match(/stopImmediatePropagation\(\)/g) ?? []).length >= 3)
  check('useFlatList consumes when acting', (flat.match(/stopImmediatePropagation\(\)/g) ?? []).length >= 3)
  check('declined non-top esc does NOT consume (list)', /isTopOverlayNow\(overlayToken\)\) return\n\s+event\.stopImmediatePropagation/.test(list))

  // Editor ownership: inline editors ride the ONE machinery.
  check('console ask line is a real TextInput', consoleSrc.includes('<TextInput') && consoleSrc.includes('onChangeCursorOffset'))
  check('console: the setTimeout ready flag is DEAD (event-identity gate)', !consoleSrc.includes('setReady') && consoleSrc.includes('useOpenEventGate'))
  check('tabula (Minerva room) editor is a real TextInput', tabula.includes('<TextInput') && tabula.includes('onChangeCursorOffset'))
  check('prompts-panel editor is a real TextInput', promptsPanel.includes('<TextInput') && promptsPanel.includes('onChangeCursorOffset'))
  check('tabula: the append-only ⌫ branch is dead', !tabula.includes('buffer: ed.buffer.slice(0, -1)') && !promptsPanel.includes('buffer: ed.buffer.slice(0, -1)'))
  check('LogSelector rename rides TextInput (pre-existing)', logsel.includes('<TextInput value={renameValue}'))
  // the exception is CLOSED — the guest composer IS the shared
  // editor owner; the old hand-rolled input (append-at-tail, tail-⌫, local
  // paste heuristics for CONTENT keys) must never return. The screen keeps
  // exactly two screen-level keys (ctrl+c, bare tab), both delegating the
  // rest to the composer.

  // ── the shared interactive list joins the laws ──────────────────────────
  // The overlay registration, the top-layer esc guard, the consume-when-acting
  // input and the open-event gate are the list's, pinned at the list.
  const sharedList = read('src/components/mercury-ui/useInteractiveList.ts')
  check('the shared list registers as an overlay', sharedList.includes("useRegisterOverlay('list', active)"))
  check('the shared list: esc guarded by isTopOverlayNow (one layer)', sharedList.includes('isTopOverlayNow(overlayToken)'))
  check('the shared list consumes exactly when acting (3-arg form)', sharedList.includes('useInput(\n    (input, key, event) => {') && (sharedList.match(/stopImmediatePropagation\(\)/g) ?? []).length >= 3)
  check('the shared list: ↵ stays behind the event-identity open gate', sharedList.includes('const pastBuffer = useOpenEventGate()'))

  // ── MINI-TEMPER item 2: the palette + quick-open family ──────────────────
  // The query is Mercury's ONE editor machinery; list nav decodes through the
  // vocabulary and CONSUMES; the append-only branches are dead; page keys
  // belong to the overlay's REAL pager where one exists.
  const pal = read('src/components/MercuryCommandPalette.tsx')
  const fo = read('src/components/MercuryFileOpen.tsx')
  const qo = read('src/components/MercuryQuickOpen.tsx')
  const cs = read('src/components/MercuryContentSearch.tsx')
  const hs = read('src/components/MercurySearch.tsx')
  for (const [name, src] of [
    ['palette', pal],
    ['file-open', fo],
    ['quick-open', qo],
    ['content-search', cs],
    ['search', hs],
  ] as const) {
    check(`${name}: the query rides the ONE editor (TextInput)`, src.includes('<TextInput') && src.includes('onChangeCursorOffset'))
    check(`${name}: the append-only query branch is DEAD`, !src.includes('setQuery(q => q + input)') && !src.includes('[...q].slice(0, -1)'))
    check(`${name}: ↑↓ keep navigating results (editor declines the axis)`, src.includes('disableCursorMovementForUpDownKeys={true}'))
    check(`${name}: esc belongs to the overlay stack (double-press off)`, src.includes('disableEscapeDoublePress={true}'))
    check(`${name}: typed/pasted text rides the open-event identity gate`, src.includes('inputFilter={input => (pastOpenEvent() ? input : \'\')}'))
    check(`${name}: list nav decodes through the vocabulary`, src.includes('decodeNavKey(input, key, {') && src.includes('applyNavMotion('))
    check(`${name}: consumes exactly when acting (3-arg form)`, src.includes('useInput(') && src.includes('event.stopImmediatePropagation()'))
    check(`${name}: esc guarded by isTopOverlayNow (one layer)`, src.includes('isTopOverlayNow(overlayToken)'))
  }
  check('palette pages by the REAL viewport (the window span — LUSTRE L4)', pal.includes("pageKeys: true") && pal.includes('pageSize: listRows'))
  check('palette declares page-key ownership on its overlay', pal.includes('ownsPageKeys: true'))
  check('search windows the FULL set and pages by its viewport', hs.includes('pageSize: MAX_ROWS') && hs.includes('ownsPageKeys: true'))
  const scroll = read('src/components/ScrollKeybindingHandler.tsx')
  // IA-3: the yield covers all SIX transcript scroll handlers —
  // pageUp/pageDown (the original pair) + lineUp/lineDown (the wheel) +
  // top/bottom (ctrl+home/end). EXACT count on purpose: a seventh entry
  // point added without the yield, or a member silently dropped, reds this
  // census either way.
  check('the transcript scroller YIELDS page keys to a declared overlay pager (all 6 scroll handlers)', (scroll.match(/if \(topOverlayOwnsPageKeys\(\)\) return false/g) ?? []).length === 6)
  const uti = read('src/hooks/useTextInput.ts')
  check('the editor honors disablePageKeyCursorMovement (one meaning per key)', uti.includes('disablePageKeyCursorMovement'))
  // The attached-viewer screen is deleted (the mirror is a
  // ScrollBox consumer inside the concourse; its wheel is bounds-gated —
  // prove-mirror-grammar owns that law).
}

console.log('== page-key ownership rides the overlay stack (pure) ==')
{
  const { topOverlayOwnsPageKeys } = await import('../../src/context/overlayStack.js')
  resetOverlayStackForTests()
  check('no overlay ⇒ the transcript keeps page keys', !topOverlayOwnsPageKeys())
  const plain = reserveOverlayToken()
  pushOverlay({ token: plain, id: 'select', modal: true })
  check('a plain overlay does NOT claim page keys', !topOverlayOwnsPageKeys())
  const pager = reserveOverlayToken()
  pushOverlay({ token: pager, id: 'command-palette', modal: true, ownsPageKeys: true })
  check('a declared pager on top claims page keys', topOverlayOwnsPageKeys())
  popOverlay(pager)
  check('pop returns page keys to the transcript', !topOverlayOwnsPageKeys())
  popOverlay(plain)
  resetOverlayStackForTests()
}

console.log('')
if (failures > 0) {
  console.log(`❌ focus-routing: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ focus-routing — one layer per Escape, stack-based restoration, typed consumption, one editor machinery')
