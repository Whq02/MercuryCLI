
import type { Key } from '../../ink/events/input-event.js'

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

export type NavOrientation =
  | 'vertical'
  | 'horizontal'
  | { grid: { columns: number } }

export type NavDecodeOptions = {
  orientation: NavOrientation
  hierarchy?: boolean
  leftCloses?: boolean
  spaceToggles?: boolean
  pageKeys?: boolean
  tabFocus?: boolean
}

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

  if (key.ctrl && input === 'p') return vertical || grid ? 'movePrevious' : null
  if (key.ctrl && input === 'n') return vertical || grid ? 'moveNext' : null

  if (key.home) return 'first'
  if (key.end) return 'last'
  if (opts.pageKeys && key.pageUp) return 'pagePrevious'
  if (opts.pageKeys && key.pageDown) return 'pageNext'

  return null
}

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
    i = to
    while (i !== from && isDisabled(i)) i -= dir
    return isDisabled(i) ? from : i
  }
  return i
}
