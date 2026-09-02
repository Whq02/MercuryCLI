
export type ConcourseMode = 'browse' | 'filter-edit' | 'coordinator-picker' | 'confirmation'

export type ConcourseFocusRegion = 'needs-you' | 'list' | 'live' | 'coordinator' | 'chat'

export interface ConcourseControlSpec {
  id: string
  action: string
  region: ConcourseFocusRegion | 'header' | 'status'
  modes: ConcourseMode[]
  keys: string[]
  pointer: 'activate' | 'select-then-activate' | 'none'
  receipt: string
  informational?: boolean
}

export const CONCOURSE_CONTROLS: readonly ConcourseControlSpec[] = [
  { id: 'crumb:boot', action: 'route:boot-settings', region: 'header', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'route-transition' },
  { id: 'crumb:main-repl', action: 'route:root-repl', region: 'header', modes: ['browse'], keys: ['escape'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'crumb:concourse', action: 'none', region: 'header', modes: ['browse'], keys: [], pointer: 'none', receipt: 'none', informational: true },
  { id: 'needs-you:row', action: 'concourse:select-obligation', region: 'needs-you', modes: ['browse'], keys: ['up', 'down'], pointer: 'select-then-activate', receipt: 'selection' },
  { id: 'needs-you:answer', action: 'concourse:answer-obligation', region: 'needs-you', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'obligation-settled' },
  { id: 'needs-you:open', action: 'concourse:open-session', region: 'needs-you', modes: ['browse'], keys: ['o'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'needs-you:withdraw', action: 'concourse:withdraw-obligation', region: 'needs-you', modes: ['browse'], keys: ['w'], pointer: 'none', receipt: 'obligation-settled' },
  { id: 'board:row', action: 'concourse:select-session', region: 'list', modes: ['browse'], keys: ['up', 'down'], pointer: 'select-then-activate', receipt: 'selection' },
  { id: 'board:open', action: 'concourse:enter-session', region: 'list', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'board:arm', action: 'concourse:arm-session', region: 'list', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'selection' },
  { id: 'board:queued-room', action: 'concourse:open-queued-room', region: 'list', modes: ['browse'], keys: ['m'], pointer: 'none', receipt: 'route-transition' },
  { id: 'board:peek', action: 'concourse:toggle-row-peek', region: 'list', modes: ['browse'], keys: ['right'], pointer: 'none', receipt: 'selection' },
  { id: 'board:older-browse', action: 'concourse:older-browse', region: 'list', modes: ['browse'], keys: ['return', 'right', 'up', 'down', 'escape'], pointer: 'select-then-activate', receipt: 'route-transition' },
  { id: 'board:group-heading', action: 'none', region: 'list', modes: ['browse'], keys: [], pointer: 'none', receipt: 'none', informational: true },
  { id: 'board:empty-start', action: 'concourse:focus-composer', region: 'list', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'focus-move' },
  { id: 'board:empty-new', action: 'concourse:new-session', region: 'list', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'route-transition' },
  { id: 'board:focus', action: 'concourse:focus-list', region: 'list', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'focus-move' },
  { id: 'coordinator:focus-title', action: 'concourse:focus-coordinator', region: 'coordinator', modes: ['browse'], keys: [], pointer: 'activate', receipt: 'focus-move' },
  { id: 'board:new-session', action: 'concourse:new-session', region: 'list', modes: ['browse'], keys: ['n'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'board:rename', action: 'concourse:rename-session', region: 'list', modes: ['browse'], keys: ['r'], pointer: 'none', receipt: 'mode-transition' },
  { id: 'board:interrupt', action: 'concourse:interrupt-session', region: 'list', modes: ['browse'], keys: ['i'], pointer: 'none', receipt: 'row-control' },
  { id: 'board:pause-resume', action: 'concourse:pause-resume-session', region: 'list', modes: ['browse'], keys: ['p'], pointer: 'none', receipt: 'row-control' },
  { id: 'board:set-model', action: 'concourse:set-session-model', region: 'list', modes: ['browse'], keys: ['m'], pointer: 'none', receipt: 'row-control' },
  { id: 'board:set-effort', action: 'concourse:set-session-effort', region: 'list', modes: ['browse'], keys: ['e'], pointer: 'none', receipt: 'row-control' },
  { id: 'board:mark', action: 'concourse:toggle-broadcast-mark', region: 'list', modes: ['browse'], keys: ['space'], pointer: 'none', receipt: 'selection' },
  { id: 'mirror:title', action: 'concourse:enter-session', region: 'live', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'live:send', action: 'concourse:live-send', region: 'live', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'row-control' },
  { id: 'board:split-toggle', action: 'concourse:toggle-split-view', region: 'list', modes: ['browse'], keys: ['s'], pointer: 'none', receipt: 'mode-transition' },
  { id: 'board:split-ratio', action: 'concourse:nudge-split-ratio', region: 'list', modes: ['browse'], keys: ['[', ']'], pointer: 'none', receipt: 'mode-transition' },
  { id: 'split:chat-enter', action: 'concourse:enter-session', region: 'chat', modes: ['browse'], keys: ['return'], pointer: 'activate', receipt: 'route-transition' },
  { id: 'live:enter-selected', action: 'concourse:enter-session', region: 'live', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'route-transition' },
  { id: 'composer:send', action: 'concourse:composer-send', region: 'coordinator', modes: ['browse'], keys: ['return'], pointer: 'none', receipt: 'coordinator-turn' },
  { id: 'composer:model-chip', action: 'concourse:coordinator-model', region: 'coordinator', modes: ['browse', 'coordinator-picker'], keys: ['ctrl+s'], pointer: 'activate', receipt: 'mode-transition' },
  { id: 'status:project-ground', action: 'concourse:ground-picker', region: 'status', modes: ['browse'], keys: ['ctrl+g'], pointer: 'activate', receipt: 'mode-transition' },
  { id: 'capacity-ask:allow', action: 'concourse:capacity-allow', region: 'coordinator', modes: ['confirmation'], keys: ['y'], pointer: 'activate', receipt: 'mode-transition' },
  { id: 'capacity-ask:decline', action: 'concourse:capacity-decline', region: 'coordinator', modes: ['confirmation'], keys: ['n', 'escape'], pointer: 'activate', receipt: 'mode-transition' },
] as const

export const CONCOURSE_BROWSE_KEYS = [
  { keys: '↑↓', label: 'browse' },
  { keys: 'tab', label: 'panes' },
  { keys: '⌃g', label: 'ground' },
  { keys: 'esc', label: 'focused chat' },
] as const

export const CONCOURSE_REGION_KEYS = {
  rail: [
    { keys: '↵', label: 'answer' },
    { keys: 'o', label: 'open session' },
    { keys: 'w', label: 'withdraw' },
  ],
  list: [
    { keys: '↵↵', label: 'enter session' },
    { keys: 'n', label: 'new session' },
    { keys: 'r', label: 'rename' },
    { keys: '→', label: 'peek' },
    { keys: '/', label: 'filter' },
    { keys: '⌃x ⌃x', label: 'stop · again removes' },
    { keys: 'm', label: 'message queued' },
    { keys: 'space', label: 'mark' },
    { keys: 's', label: 'split' },
  ],
  live: [
    { keys: '⇧↵/⌃j', label: 'newline' },
    { keys: 'pgup/pgdn', label: 'scroll' },
  ],
  coordinator: [
    { keys: '↵', label: 'send' },
    { keys: '⇧↵/⌃j', label: 'newline' },
    { keys: '⌃s', label: 'coordinator model' },
    { keys: 'pgup/pgdn', label: 'scroll' },
  ],
  chat: [
    { keys: '↵', label: 'full chat' },
    { keys: 's', label: 'full board' },
    { keys: '[ ]', label: 'divider' },
    { keys: 'pgup/pgdn', label: 'scroll' },
  ],
} as const

export const CONCOURSE_HELP_KEY = { keys: '?', label: 'keys' } as const

export function browseKeysFor(opts: {
  chatPresent: boolean
  region?: keyof typeof CONCOURSE_REGION_KEYS
}): ReadonlyArray<{ keys: string; label: string }> {
  const rows = opts.region === 'coordinator' ? CONCOURSE_BROWSE_KEYS.filter(k => k.keys !== '↑↓') : CONCOURSE_BROWSE_KEYS
  return rows.map(k =>
    k.keys === 'esc'
      ? { keys: 'esc', label: opts.chatPresent ? 'focused chat' : 'boot face' }
      : k.keys === '↑↓' && opts.region === undefined
        ? { keys: '↑↓', label: 'browse (list · live · split)' }
        : k,
  )
}

export type BoardSelectionClass =
  | 'live'
  | 'paused'
  | 'attached'
  | 'queued'
  | 'parked'
  | 'stopped'
  | 'door'
  | 'none'

export function boardSelectionClassOf(
  row?: { sessionId: string; state: string; door?: unknown },
): BoardSelectionClass {
  if (row === undefined) return 'none'
  if (row.door !== undefined || row.sessionId.startsWith('older:') || row.state === 'elsewhere') return 'door'
  if (row.sessionId.startsWith('dispatch:') || row.state === 'queued') return 'queued'
  if (row.state === 'parked') return 'parked'
  if (row.state === 'attached') return 'attached'
  if (row.state === 'stopped') return 'stopped'
  if (row.state === 'paused') return 'paused'
  return 'live'
}

export function regionKeysFor(
  region: keyof typeof CONCOURSE_REGION_KEYS,
  opts: {
    newSession: boolean
    selection?: BoardSelectionClass
    chatSession?: boolean
    landing?: boolean
    olderBrowse?: boolean
    armed?: boolean
    liveDraftHeld?: boolean
  },
): ReadonlyArray<{ keys: string; label: string }> {
  if (opts.olderBrowse === true) {
    return [{ keys: '↵', label: 'bring it back' }]
  }
  const stageFilter = (rows: ReadonlyArray<{ keys: string; label: string }>): ReadonlyArray<{ keys: string; label: string }> =>
    opts.newSession
      ? rows
      : rows
          .filter(k => k.keys !== 'n' && k.keys !== 'r' && k.keys !== 's' && k.keys !== 'space' && k.keys !== '⇧↵/⌃j')
          .map(k => (k.keys === '↵↵' ? { keys: '↵', label: k.label } : k))
  if (region === 'chat') {
    if (opts.landing === true) return CONCOURSE_REGION_KEYS.chat.filter(k => k.keys !== '↵')
    return CONCOURSE_REGION_KEYS.chat.map(k =>
      k.keys === '↵' && opts.chatSession === false ? { keys: '↵', label: 'new session' } : k,
    )
  }
  if (region !== 'list') {
    return stageFilter(CONCOURSE_REGION_KEYS[region])
  }
  const withEnterTruth = (rows: ReadonlyArray<{ keys: string; label: string }>): ReadonlyArray<{ keys: string; label: string }> =>
    rows.map(k =>
      k.keys === '↵↵' && opts.liveDraftHeld === true
        ? { keys: '↵', label: 'send' }
        : k.keys === '↵↵' && opts.armed === true
          ? { keys: '↵', label: 'enters (armed)' }
          : k.keys === '→' && opts.armed === true
            ? { keys: '→', label: 'enter' }
            : k,
    )
  if (opts.selection === undefined) {
    return withEnterTruth(stageFilter(CONCOURSE_REGION_KEYS.list))
  }
  const base = CONCOURSE_REGION_KEYS.list
  const row = (keys: string): { keys: string; label: string } | undefined => base.find(k => k.keys === keys)
  const keep = (...names: string[]): Array<{ keys: string; label: string }> =>
    names.map(n => row(n)).filter((k): k is { keys: string; label: string } => k !== undefined)
  const listRowsFor = (selection: BoardSelectionClass): ReadonlyArray<{ keys: string; label: string }> => {
    switch (selection) {
      case 'live':
      case 'paused':
        return stageFilter([
          ...keep('↵↵'),
          { keys: 'i', label: 'interrupt' },
          { keys: 'p', label: selection === 'paused' ? 'resume' : 'pause' },
          { keys: 'm', label: 'model' },
          { keys: 'e', label: 'effort' },
          ...keep('r', '→', '/', '⌃x ⌃x', 'n', 'space', 's'),
        ])
      case 'attached':
        return stageFilter([...keep('↵↵', 'n', 'r', '→', '/', '⌃x ⌃x', 'space', 's')])
      case 'queued':
        return stageFilter([...keep('n', 'm', '/'), { keys: '⌃x ⌃x', label: 'withdraw' }, ...keep('space', 's')])
      case 'parked':
        return stageFilter([{ keys: 'parked', label: '· ↵ brings it back' }, ...keep('n', 'r', '/'), { keys: '⌃x ⌃x', label: 'clear' }, ...keep('space', 's')])
      case 'stopped':
        return stageFilter([...keep('n', '/'), { keys: '⌃x ⌃x', label: 'remove' }, ...keep('space', 's')])
      case 'door':
        return stageFilter([{ keys: '↵', label: 'open' }, ...keep('n', '/', 'space', 's')])
      case 'none':
        return stageFilter([...keep('n', '/', 's')])
    }
  }
  return withEnterTruth(listRowsFor(opts.selection))
}

export function withSplitViewTruth(
  rows: ReadonlyArray<{ keys: string; label: string }>,
  opts: { splitOn: boolean },
): ReadonlyArray<{ keys: string; label: string }> {
  if (!opts.splitOn) return rows
  const out = rows.map(k => (k.keys === 's' ? { keys: 's', label: 'full board' } : k))
  const sAt = out.findIndex(k => k.keys === 's')
  if (sAt !== -1 && !out.some(k => k.keys === '[ ]')) {
    out.splice(sAt + 1, 0, { keys: '[ ]', label: 'divider' })
  }
  return out
}

export function legendPriorityOf(keys: string, opts: { splitOn: boolean }): number {
  if (keys === 'esc') return 4
  if (keys === 's' && opts.splitOn) return 3.7
  if (keys === '?') return 3.5
  if (keys === '↑↓') return 2
  if (keys === 'tab') return 1.9
  if (keys === '⌃g') return 1
  return 3
}

export const COORDINATOR_SURFACE_KEYS = [
  { keys: '↵', label: 'send' },
  { keys: '⌃s', label: 'coordinator model' },
  { keys: '⇧↵/⌃j', label: 'newline' },
  { keys: 'pgup/pgdn', label: 'scroll' },
] as const

export function newSessionTabLabel(opts: { region: string; filtering: boolean }): string {
  return opts.region === 'list' && !opts.filtering ? '+ new session · n' : '+ new session'
}

export function helpKeyFiresFor(region: string, focusedComposerEmpty: boolean): boolean {
  if (region !== 'coordinator' && region !== 'live') return true
  return focusedComposerEmpty
}
