// ============================================================================
//  navSemantics — the ONE semantic navigation vocabulary.
//
//  Raw key sequences map to SEMANTIC actions at the owning component boundary;
//  components never reinterpret a direction as an unrelated direction. The
// vocabulary is the verb set; the decoders below are the only
//  sanctioned raw→semantic tables for collection/dialog surfaces (text editors
//  keep their own grapheme/line grammar — useTextInput owns that domain).
//
//  Laws (proved in scripts/navigation/prove-nav-semantics.ts):
//  · VERTICAL collections: ↑↓ move, PageUp/PageDown page (only when the
//    surface declares a real viewport), Home/End reach the ends. ←→ are NOT
//    aliases of ↑↓ — on a plain vertical list they decode to null; they gain
//    meaning only where the visible hierarchy teaches it (`hierarchy` →
//    leaveChild/enterChild) or where the surface ADVERTISES the Mercury
//    ←-close convention (`leftCloses` → cancel, the `esc / ← close` footer).
//  · HORIZONTAL controls (tabs, segments, sliders): ←→ move, ↑↓ decode null —
//    never a silent second spelling of the same motion.
//  · GRIDS (wrapped card layouts): ←→ move linearly, ↑↓ move by ROW
//    (±columns) — the geometry the operator can see is the geometry the keys
//    obey.
//  · One event, one meaning: the decoder returns at most ONE action; owners
//    consume or decline — they never run two interpretations of one key.
//  · Emacs aliases ctrl+p/ctrl+n ride wherever ↑↓ ride (the QuestionView
//    convention, now universal).
//  · Space toggles ONLY where the surface declares toggle rows — on every
//    other surface a space stays a printable character.
// ============================================================================

import type { Key } from '../../ink/events/input-event.js'

/** The semantic action vocabulary. */
export type NavAction =
  | 'movePrevious'
  | 'moveNext'
  | 'moveLeft'
  | 'moveRight'
  | 'pagePrevious'
  | 'pageNext'
  | 'first'
  | 'last'
  | 'enterChild'
  | 'leaveChild'
  | 'activate'
  | 'toggle'
  | 'submit'
  | 'cancel'
  | 'focusNext'
  | 'focusPrevious'
  | 'edit'
  | 'openHelp'

/** How a collection is visibly laid out — the axis its motion keys obey. */
export type NavOrientation =
  | 'vertical'
  | 'horizontal'
  | { grid: { columns: number } }

export type NavDecodeOptions = {
  orientation: NavOrientation
  /** The surface has a real, visible parent/child axis (board drill): on a
   *  vertical collection ← decodes leaveChild and → enterChild. */
  hierarchy?: boolean
  /** The surface advertises the Mercury `esc / ← close` convention in its
   *  footer: ← at the root decodes cancel. Ignored when `hierarchy` is set
   *  (a taught child axis outranks the close synonym). */
  leftCloses?: boolean
  /** Space toggles the focused row (multi-choice / checkbox surfaces). */
  spaceToggles?: boolean
  /** The surface renders a real bounded viewport: PageUp/PageDown decode. */
  pageKeys?: boolean
  /** Tab/shift+Tab walk a visible focus order on this surface. */
  tabFocus?: boolean
}

/** Decode one ink `(input, key)` event into at most one semantic action, or
 *  null when this surface assigns the key no meaning (the owner must then
 *  DECLINE the event so lower-priority owners can see it). */
export function decodeNavKey(
  input: string,
  key: Key,
  opts: NavDecodeOptions,
): NavAction | null {
  const { orientation } = opts
  const vertical = orientation === 'vertical'
  const horizontal = orientation === 'horizontal'
  const grid = typeof orientation === 'object'

  if (key.escape) return 'cancel'
  if (key.tab && opts.tabFocus) return key.shift ? 'focusPrevious' : 'focusNext'
  if (key.return) return 'activate'
  if (opts.spaceToggles && input === ' ' && !key.ctrl && !key.meta) return 'toggle'

  if (key.upArrow) return vertical || grid ? 'movePrevious' : null
  if (key.downArrow) return vertical || grid ? 'moveNext' : null
  if (key.leftArrow) {
    if (horizontal || grid) return 'moveLeft'
    if (opts.hierarchy) return 'leaveChild'
    if (opts.leftCloses) return 'cancel'
    return null
  }
  if (key.rightArrow) {
    if (horizontal || grid) return 'moveRight'
    if (opts.hierarchy) return 'enterChild'
    return null
  }

  // Emacs aliases ride the vertical axis wherever ↑↓ ride.
  if (key.ctrl && input === 'p') return vertical || grid ? 'movePrevious' : null
  if (key.ctrl && input === 'n') return vertical || grid ? 'moveNext' : null

  if (key.home) return 'first'
  if (key.end) return 'last'
  if (opts.pageKeys && key.pageUp) return 'pagePrevious'
  if (opts.pageKeys && key.pageDown) return 'pageNext'

  return null
}

/** The ink DOM keyboard path (`onKeyDown` — QuestionView, Settings, wizards)
 *  carries `{ key, ctrl, shift }` with the same normalized key names the input
 *  layer mints ('up', 'down', 'return', 'escape', 'tab', 'left', 'right',
 *  'home', 'end', 'pageup', 'pagedown', 'space'). Same table, same laws. */
export function decodeDomNavKey(
  e: { key: string; ctrl?: boolean; shift?: boolean },
  opts: NavDecodeOptions,
): NavAction | null {
  const k = e.key
  const flag = (name: string): boolean => k === name
  const synthetic: Key = {
    upArrow: flag('up'),
    downArrow: flag('down'),
    leftArrow: flag('left'),
    rightArrow: flag('right'),
    pageDown: flag('pagedown'),
    pageUp: flag('pageup'),
    wheelUp: false,
    wheelDown: false,
    home: flag('home'),
    end: flag('end'),
    return: flag('return'),
    escape: flag('escape'),
    ctrl: e.ctrl ?? false,
    shift: e.shift ?? false,
    fn: false,
    tab: flag('tab'),
    backspace: flag('backspace'),
    delete: flag('delete'),
    meta: false,
    super: false,
    isPasted: false,
  }
  const input = k.length === 1 ? k : k === 'space' ? ' ' : ''
  return decodeNavKey(input, synthetic, opts)
}

/** Translate a decoded motion into an index move over a flat row array.
 *  Returns the NEW index (clamped, never wrapped), or null when the action is
 *  not a motion this orientation understands. `pageSize` feeds page motions;
 *  grids move by row on the vertical axis. Clamp-don't-wrap is the kit law. */
export function applyNavMotion(
  action: NavAction,
  index: number,
  length: number,
  opts: { orientation: NavOrientation; pageSize?: number },
): number | null {
  if (length <= 0) return null
  const clamp = (i: number): number => Math.min(Math.max(0, i), length - 1)
  const grid = typeof opts.orientation === 'object' ? opts.orientation.grid : null
  const rowStride = grid ? Math.max(1, grid.columns) : 1
  const page = Math.max(1, opts.pageSize ?? 1)
  switch (action) {
    case 'movePrevious':
      return clamp(index - rowStride)
    case 'moveNext':
      return clamp(index + rowStride)
    case 'moveLeft':
      return clamp(index - 1)
    case 'moveRight':
      return clamp(index + 1)
    case 'pagePrevious':
      return clamp(index - page)
    case 'pageNext':
      return clamp(index + page)
    case 'first':
      return 0
    case 'last':
      return length - 1
    default:
      return null
  }
}

/** Walk from `index` in `dir` to the next row that is NOT disabled, skipping
 *  disabled rows entirely.
 *  Returns the landing index, or the original index when no enabled row exists
 *  in that direction (clamp-don't-wrap — never loops around). The ONE
 *  availability policy (MINI-TEMPER item 5): a disabled row is non-interactive
 *  on EVERY channel and carries its explanation as visible paint — a surface
 *  that wants a reachable row simply doesn't mark it disabled. */
export function skipDisabled(
  from: number,
  to: number,
  length: number,
  isDisabled: (i: number) => boolean,
): number {
  if (length <= 0) return from
  if (to === from) return from
  const dir = to > from ? 1 : -1
  let i = to
  while (i >= 0 && i < length && isDisabled(i)) i += dir
  if (i < 0 || i >= length) {
    // Ran off the end: fall back toward the origin for a landable row.
    i = to
    while (i !== from && isDisabled(i)) i -= dir
    return isDisabled(i) ? from : i
  }
  return i
}
