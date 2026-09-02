#!/usr/bin/env bun
// ============================================================================
//  scripts/navigation/prove-nav-semantics.ts — the ONE semantic
//  navigation vocabulary (navSemantics.ts) and its kernel adoption.
//
//  Laws proved here:
//   · vertical collections: ↑↓/Home/End (+ctrl+p/n) move; ←→ decode NOTHING
//     unless the surface declares hierarchy (leave/enterChild) or the
//     advertised ←-close convention (cancel);
//   · horizontal controls: ←→ move; ↑↓ decode nothing (no silent alias);
//   · grids: ←→ linear; ↑↓ by ROW (±columns);
//   · page keys decode only for surfaces with a real viewport; space toggles
//     only where declared;
//   · applyNavMotion clamps, never wraps; grid vertical stride = columns;
//   · skipDisabled: disabled rows are skipped in the motion direction,
//     falling back toward the origin, never wrapping, never landing disabled;
//   · SOURCE PINS: the kit hooks (useInteractiveList · useNavigablePanes ·
//     useFlatList) decode through the vocabulary — no raw arrow aliasing
//     left; useFlatList rides the EVENT-IDENTITY gate + stable-ID selection;
//     CustomSelect navigation skips disabled options; CritterSelect declares
//     its real geometry; QuestionView's DOM handler maps at the boundary.
//
//  Run: ~/.bun/bin/bun run scripts/navigation/prove-nav-semantics.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyNavMotion,
  decodeDomNavKey,
  decodeNavKey,
  skipDisabled,
  type NavAction,
  type NavDecodeOptions,
} from '../../src/components/mercury-ui/navSemantics.js'
import type { Key } from '../../src/ink/events/input-event.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.COMPASS_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const K = (over: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  wheelUp: false,
  wheelDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  fn: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  ...over,
})

const dec = (input: string, over: Partial<Key>, opts: NavDecodeOptions): NavAction | null =>
  decodeNavKey(input, K(over), opts)

console.log('== the vertical law: ←→ are never disguised ↑↓ ==')
const V: NavDecodeOptions = { orientation: 'vertical' }
check('↑ → movePrevious', dec('', { upArrow: true }, V) === 'movePrevious')
check('↓ → moveNext', dec('', { downArrow: true }, V) === 'moveNext')
check('← decodes NOTHING on a plain vertical list', dec('', { leftArrow: true }, V) === null)
check('→ decodes NOTHING on a plain vertical list', dec('', { rightArrow: true }, V) === null)
check('ctrl+p rides with ↑', dec('p', { ctrl: true }, V) === 'movePrevious')
check('ctrl+n rides with ↓', dec('n', { ctrl: true }, V) === 'moveNext')
check('home → first', dec('', { home: true }, V) === 'first')
check('end → last', dec('', { end: true }, V) === 'last')
check('esc → cancel', dec('', { escape: true }, V) === 'cancel')
check('↵ → activate', dec('', { return: true }, V) === 'activate')
check('pageUp decodes NOTHING without a declared viewport', dec('', { pageUp: true }, V) === null)
check('pageUp → pagePrevious with pageKeys', dec('', { pageUp: true }, { ...V, pageKeys: true }) === 'pagePrevious')
check('pageDown → pageNext with pageKeys', dec('', { pageDown: true }, { ...V, pageKeys: true }) === 'pageNext')
check('space is a plain printable without spaceToggles', dec(' ', {}, V) === null)
check('space → toggle where declared', dec(' ', {}, { ...V, spaceToggles: true }) === 'toggle')
check('tab decodes NOTHING without tabFocus', dec('', { tab: true }, V) === null)
check('tab → focusNext with tabFocus', dec('', { tab: true }, { ...V, tabFocus: true }) === 'focusNext')
check('shift+tab → focusPrevious', dec('', { tab: true, shift: true }, { ...V, tabFocus: true }) === 'focusPrevious')

console.log('== hierarchy + the advertised ←-close convention ==')
const H: NavDecodeOptions = { orientation: 'vertical', hierarchy: true }
check('← → leaveChild on a taught hierarchy', dec('', { leftArrow: true }, H) === 'leaveChild')
check('→ → enterChild on a taught hierarchy', dec('', { rightArrow: true }, H) === 'enterChild')
const LC: NavDecodeOptions = { orientation: 'vertical', leftCloses: true }
check('← → cancel under the advertised close convention', dec('', { leftArrow: true }, LC) === 'cancel')
check('hierarchy outranks leftCloses', dec('', { leftArrow: true }, { ...H, leftCloses: true }) === 'leaveChild')

console.log('== the horizontal law: ↑↓ are never a silent second spelling ==')
const Hz: NavDecodeOptions = { orientation: 'horizontal' }
check('← → moveLeft', dec('', { leftArrow: true }, Hz) === 'moveLeft')
check('→ → moveRight', dec('', { rightArrow: true }, Hz) === 'moveRight')
check('↑ decodes NOTHING on a horizontal control', dec('', { upArrow: true }, Hz) === null)
check('↓ decodes NOTHING on a horizontal control', dec('', { downArrow: true }, Hz) === null)

console.log('== the grid law: keys obey the visible geometry ==')
const G: NavDecodeOptions = { orientation: { grid: { columns: 2 } } }
check('grid ← → moveLeft', dec('', { leftArrow: true }, G) === 'moveLeft')
check('grid → → moveRight', dec('', { rightArrow: true }, G) === 'moveRight')
check('grid ↑ → movePrevious (by row)', dec('', { upArrow: true }, G) === 'movePrevious')
check('grid ↓ → moveNext (by row)', dec('', { downArrow: true }, G) === 'moveNext')

console.log('== motion application: clamp-don\'t-wrap; grid row stride ==')
check('vertical ↓ from 0/3 → 1', applyNavMotion('moveNext', 0, 3, { orientation: 'vertical' }) === 1)
check('vertical ↑ clamps at 0', applyNavMotion('movePrevious', 0, 3, { orientation: 'vertical' }) === 0)
check('vertical ↓ clamps at end', applyNavMotion('moveNext', 2, 3, { orientation: 'vertical' }) === 2)
check('first → 0', applyNavMotion('first', 2, 3, { orientation: 'vertical' }) === 0)
check('last → n-1', applyNavMotion('last', 0, 3, { orientation: 'vertical' }) === 2)
check('page moves by pageSize', applyNavMotion('pageNext', 0, 20, { orientation: 'vertical', pageSize: 7 }) === 7)
check('grid ↓ moves by row (+columns)', applyNavMotion('moveNext', 0, 4, { orientation: { grid: { columns: 2 } } }) === 2)
check('grid ↑ moves by row (−columns)', applyNavMotion('movePrevious', 3, 4, { orientation: { grid: { columns: 2 } } }) === 1)
check('grid → moves linearly', applyNavMotion('moveRight', 0, 4, { orientation: { grid: { columns: 2 } } }) === 1)
check('grid ↓ clamps on the partial last row', applyNavMotion('moveNext', 2, 4, { orientation: { grid: { columns: 2 } } }) === 3)
check('empty list → null', applyNavMotion('moveNext', 0, 0, { orientation: 'vertical' }) === null)
check('activate is not a motion', applyNavMotion('activate', 1, 3, { orientation: 'vertical' }) === null)

console.log('== disabled rows are skipped (never landed, never wrapped) ==')
const dis = (set: number[]) => (i: number) => set.includes(i)
check('skips one disabled row forward', skipDisabled(0, 1, 4, dis([1])) === 2)
check('skips a disabled run forward', skipDisabled(0, 1, 5, dis([1, 2, 3])) === 4)
check('skips backward', skipDisabled(3, 2, 4, dis([2])) === 1)
check('all-disabled ahead falls back toward the origin', skipDisabled(1, 2, 4, dis([2, 3])) === 1)
check('enabled target lands unchanged', skipDisabled(0, 2, 4, dis([1])) === 2)
check('never wraps past the front', skipDisabled(2, 1, 4, dis([0, 1])) === 2)

console.log('== DOM-boundary decode (the onKeyDown family) ==')
check("dom 'up' → movePrevious", decodeDomNavKey({ key: 'up' }, V) === 'movePrevious')
check("dom ctrl+'n' → moveNext", decodeDomNavKey({ key: 'n', ctrl: true }, V) === 'moveNext')
check("dom 'return' → activate", decodeDomNavKey({ key: 'return' }, V) === 'activate')
check("dom 'escape' → cancel", decodeDomNavKey({ key: 'escape' }, V) === 'cancel')
check("dom 'left' decodes NOTHING on vertical", decodeDomNavKey({ key: 'left' }, V) === null)

console.log('== source pins: the kernel derives from the vocabulary ==')
{
  const list = readFileSync(join(root, 'src/components/mercury-ui/useInteractiveList.ts'), 'utf8')
  const panes = readFileSync(join(root, 'src/components/mercury-ui/useNavigablePanes.ts'), 'utf8')
  const flat = readFileSync(join(root, 'src/components/mercury-ui/useFlatList.ts'), 'utf8')
  const selectNav = readFileSync(join(root, 'src/components/CustomSelect/use-select-navigation.ts'), 'utf8')
  const critter = readFileSync(join(root, 'src/components/CritterSelect.tsx'), 'utf8')
  const qview = readFileSync(join(root, 'src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx'), 'utf8')

  check('useInteractiveList decodes through the vocabulary', list.includes('decodeNavKey(input, key, { orientation })'))
  check('useInteractiveList: the ←→↑↓ alias is DEAD (no raw arrow moves)', !/key\.upArrow \|\| key\.leftArrow/.test(list) && !/key\.downArrow \|\| key\.rightArrow/.test(list))
  check('useInteractiveList: keyboard motion skips unavailable rows', list.includes('skipDisabled('))
  check('useInteractiveList: the cursor never OPENS on an unavailable row', list.includes('rows.findIndex(r => !unavailable(r))'))
  check('useInteractiveList rides the ONE identity core', list.includes('useStableSelection(rows, rowId'))
  check('useNavigablePanes: all three axes decode through the vocabulary', (panes.match(/decodeNavKey\(/g) ?? []).length >= 3)
  check('useNavigablePanes: identity-first section memory', panes.includes('sectionRowKeys') && /key: keys\?\.\[clampedSection\]\?\.\[clampedSel\]/.test(panes))
  check('useNavigablePanes: the stale wall-clock gate doc is gone', !panes.includes('wall-clock comparison against a mount timestamp'))
  check('useFlatList rides the EVENT-IDENTITY gate (not wall-clock)', flat.includes('useOpenEventGate') && !flat.includes('Date.now() - mountedAt'))
  check('useFlatList: stable-ID selection across reload', flat.includes('selKeyRef') && flat.includes('rowId'))
  check('useFlatList decodes through the vocabulary', flat.includes('decodeNavKey(input, key, {'))
  check('CustomSelect: navigation skips disabled options', selectNav.includes('while (next && next.disabled) next = next.next') && selectNav.includes('while (previous && previous.disabled) previous = previous.previous'))
  check('CustomSelect: initial focus lands enabled', selectNav.includes('(firstEnabled(optionMap) ?? optionMap.first)?.value'))
  check('CritterSelect declares its REAL geometry (grid/horizontal)', critter.includes("{ grid: { columns: 2 } } : 'horizontal'"))
  check('CritterSelect: the footer hint PROJECTS the declared orientation', critter.includes('${nav.motionHint} / click move'))
  check('the kit exposes the orientation-truthful motion hint', list.includes('motionHint:'))
  check('QuestionView maps DOM keys at the boundary', qview.includes('decodeDomNavKey(e, {'))
  check('QuestionView: no raw footer arrow comparisons left', !/e\.key === "up" \|\| e\.ctrl && e\.key === "p"/.test(qview))

  // ── S2b: index-only selection over LIVE data → identity-stable ────────────
  const smv = readFileSync(join(root, 'src/components/mercury-ui/screens/SessionManagerView.tsx'), 'utf8')
  const tcv = readFileSync(join(root, 'src/components/mercury-ui/screens/TeammateChatsView.tsx'), 'utf8')
  const fm = readFileSync(join(root, 'src/components/FleetMonitor.tsx'), 'utf8')
  const rdp = readFileSync(join(root, 'src/components/tasks/RunDetailPane.tsx'), 'utf8')
  const td = readFileSync(join(root, 'src/components/teams/TeamsDialog.tsx'), 'utf8')
  const hfc = readFileSync(join(root, 'src/components/MercuryFleetChat.tsx'), 'utf8')
  check('SessionManagerView: identity-stable card cursor', smv.includes('useStableSelection(navKeys'))
  check('SessionManagerView: the switch confirm is armed by IDENTITY (never a retarget)', smv.includes('setConfirmingKey(navKeys[') && smv.includes("useState<string | null>(null)"))
  check('TeammateChatsView: the roster cursor follows the teammate name', tcv.includes('useStableSelection(rows, r => r.member.name)'))
  check('TeammateChatsView: the model picker is HORIZONTAL (no ↑↓ alias)', tcv.includes("decodeNavKey(input, key, { orientation: 'horizontal' })") && !/key\.leftArrow \|\| key\.upArrow/.test(tcv))
  check('FleetMonitor: identity-stable roster cursor', fm.includes('useStableSelection(roster, a => a.name)'))
  check('RunDetailPane: identity-stable lane cursor + drill hierarchy', rdp.includes('useStableSelection(agents') && rdp.includes("hierarchy: true"))
  check('TeamsDialog: the 1s-poll roster follows the teammate name', td.includes('useStableSelection(teammateStatuses, t => t.name)'))
  check('MercuryFleetChat: identity-stable target cursor', hfc.includes('useStableSelection(team, t => t.name)'))

  // ── MINI-TEMPER item 5: ONE availability policy, every channel agrees ────
  // RESOLVED (deliberately, per the brief's first option): an unavailable row
  // is NON-INTERACTIVE on every channel — keyboard skips, select()/moveTo
  // heal past it, InteractiveRow strips pointer handlers + hover — and its
  // explanation is VISIBLE PAINT (rowProps.reasonUnavailable → the dim inline
  // annotation), never an activation note nobody can reach.
  const irow = readFileSync(join(root, 'src/components/mercury-ui/InteractiveRow.tsx'), 'utf8')
  check('the dead activation-explanation promise is DEAD', !list.includes('setNote(reasonUnavailable'))
  // (The heal's basis moved to the SYNCHRONOUS cursor — liveIndexRef — in
  // the batch-safety work: same policy, batch-safe reference.)
  check('select()/moveTo heal past unavailable rows (skipDisabled)', /const select = [\s\S]{0,600}skipDisabled\(liveIndexRef\.current, idx/.test(list))
  check('rowProps carries the visible WHY', list.includes('reasonUnavailable: isUnavailable(row) ? reasonUnavailable?.(row) : undefined'))
  check('InteractiveRow paints the WHY dim + inline', irow.includes('unavailable && reasonUnavailable') && irow.includes('` — ${reasonUnavailable}`'))
  check('InteractiveRow strips pointer interactivity on dead rows', irow.includes('const interactive = !unavailable && (!!onSelect || !!onActivate)'))
  check('the hint face is availability-derived (no hint on dead rows)', irow.includes('row.unavailable ? undefined : row.actionLabel'))

}

console.log('')
if (failures > 0) {
  console.log(`❌ nav-semantics: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ nav-semantics — one vocabulary, orientation-honest keys, disabled rows skipped, kernel adopted')
