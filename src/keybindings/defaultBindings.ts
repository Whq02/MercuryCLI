import { satisfies } from 'semver'
import type { ActionGraph } from './actionGraph.js'
import type { KeybindingBlock } from './types.js'

type GraphAction = keyof ActionGraph
type GraphContext = ActionGraph[GraphAction]['contexts'][number]
type BoundIn<Context extends GraphContext> =
  | { [Action in GraphAction]: Context extends ActionGraph[Action]['contexts'][number] ? Action : never }[GraphAction]
  | `command:${string}`
type ShippedRows = { [Context in GraphContext]?: Record<string, BoundIn<Context>> }

const VT_MODE_FLOORS = { bun: '>=1.2.23', node: '>=22.17.0 <23.0.0 || >=24.2.0' } as const

type HostChords = { modeCycle: string; imagePaste: string; copyRows: Record<string, BoundIn<'Scroll'>> }

function hostChords(platform: NodeJS.Platform, versions: NodeJS.ProcessVersions): HostChords {
  const windows = platform === 'win32'
  const consoleHasVtMode = (): boolean => (versions.bun ? satisfies(versions.bun, VT_MODE_FLOORS.bun) : satisfies(versions.node, VT_MODE_FLOORS.node))
  return {
    modeCycle: !windows || consoleHasVtMode() ? 'shift+tab' : 'meta+m',
    imagePaste: windows ? 'alt+v' : 'ctrl+v',
    copyRows: platform === 'darwin' ? { 'cmd+c': 'selection:copy' } : {},
  }
}

const HOST = hostChords(process.platform, process.versions)

const SELECT_LIST_KEYS = {
  wheel: { wheelup: 'select:previous', wheeldown: 'select:next' },
  ctrlPrevNext: { 'ctrl+p': 'select:previous', 'ctrl+n': 'select:next' },
  ends: { home: 'select:first', end: 'select:last' },
} as const satisfies Record<string, Record<string, BoundIn<'Settings'> & BoundIn<'Select'>>>

const SHIPPED_KEYS = {
  Global: {
    'ctrl+c': 'app:interrupt',
    'ctrl+d': 'app:exit',
    'ctrl+l': 'app:redraw',
    'ctrl+t': 'app:toggleTasks',
    'ctrl+pagedown': 'app:cycleSurfaceForward',
    'ctrl+pageup': 'app:cycleSurfaceBack',
    'shift+right': 'app:surfaceRight',
    'shift+left': 'app:surfaceLeft',
    'ctrl+x p': 'app:commandPalette',
    'ctrl+x f': 'app:fileOpen',
    'ctrl+x g': 'app:contentSearch',
    'ctrl+x k': 'command:workbench',
    'ctrl+x s': 'command:sessions',
    'ctrl+x y': 'command:copy',
    'ctrl+x c': 'app:openSurfaceSwitcher',
    'ctrl+x ctrl+x': 'concourse:closeSession',
    'ctrl+o': 'app:toggleTranscript',
    'ctrl+r': 'history:search',
  },
  Chat: {
    escape: 'chat:cancel',
    'ctrl+x ctrl+k': 'chat:killAgents',
    'shift+b': 'chat:backgroundShell',
    [HOST.modeCycle]: 'chat:cycleMode',
    'meta+p': 'chat:modelPicker',
    'meta+t': 'chat:thinkingToggle',
    'ctrl+_': 'chat:undo',
    'ctrl+shift+-': 'chat:undo',
    'ctrl+x ctrl+r': 'chat:redo',
    'ctrl+x ctrl+e': 'chat:externalEditor',
    'ctrl+s': 'chat:stash',
    [HOST.imagePaste]: 'chat:imagePaste',
    'shift+up': 'chat:messageActions',
  },
  Autocomplete: {
    tab: 'autocomplete:accept',
    escape: 'autocomplete:dismiss',
    up: 'autocomplete:previous',
    down: 'autocomplete:next',
  },
  Settings: {
    escape: 'confirm:no',
    ...SELECT_LIST_KEYS.wheel,
    up: 'select:previous',
    down: 'select:next',
    k: 'select:previous',
    j: 'select:next',
    ...SELECT_LIST_KEYS.ctrlPrevNext,
    ...SELECT_LIST_KEYS.ends,
    space: 'select:accept',
    r: 'settings:retry',
  },
  Confirmation: {
    y: 'confirm:yes',
    n: 'confirm:no',
    enter: 'confirm:yes',
    escape: 'confirm:no',
    up: 'confirm:previous',
    down: 'confirm:next',
    'shift+tab': 'confirm:cycleMode',
    'shift+n': 'confirm:approveWithFeedback',
    'ctrl+e': 'confirm:toggleExplanation',
    'ctrl+f': 'confirm:toggleFullPreview',
    'ctrl+d': 'permission:toggleDebug',
    'ctrl+g': 'chat:externalEditor',
  },
  Tabs: {
    tab: 'tabs:next',
    right: 'tabs:next',
    'shift+tab': 'tabs:previous',
    left: 'tabs:previous',
  },
  Transcript: {
    'ctrl+e': 'transcript:toggleShowAll',
    'ctrl+c': 'transcript:exit',
    escape: 'transcript:exit',
    q: 'transcript:exit',
  },
  HistorySearch: {
    'ctrl+r': 'historySearch:next',
    escape: 'historySearch:accept',
    tab: 'historySearch:accept',
    'ctrl+c': 'historySearch:cancel',
    enter: 'historySearch:execute',
  },
  Task: { 'ctrl+b': 'task:background' },
  ThemePicker: { 'ctrl+t': 'theme:toggleSyntaxHighlighting' },
  Scroll: {
    pageup: 'scroll:pageUp',
    pagedown: 'scroll:pageDown',
    wheelup: 'scroll:lineUp',
    wheeldown: 'scroll:lineDown',
    'ctrl+home': 'scroll:top',
    'ctrl+end': 'scroll:bottom',
    'alt+down': 'scroll:bottom',
    'ctrl+shift+c': 'selection:copy',
    ...HOST.copyRows,
  },
  Help: { escape: 'help:dismiss' },
  Attachments: {
    right: 'attachments:next',
    left: 'attachments:previous',
    backspace: 'attachments:remove',
    delete: 'attachments:remove',
    down: 'attachments:exit',
    escape: 'attachments:exit',
  },
  Footer: {
    up: 'footer:up',
    'ctrl+p': 'footer:up',
    down: 'footer:down',
    'ctrl+n': 'footer:down',
    right: 'footer:next',
    left: 'footer:previous',
    enter: 'footer:openSelected',
    escape: 'footer:clearSelection',
  },
  MessageSelector: {
    escape: 'messageSelector:close',
    up: 'messageSelector:up',
    k: 'messageSelector:up',
    'ctrl+p': 'messageSelector:up',
    down: 'messageSelector:down',
    j: 'messageSelector:down',
    'ctrl+n': 'messageSelector:down',
    'ctrl+up': 'messageSelector:top',
    'shift+up': 'messageSelector:top',
    'meta+up': 'messageSelector:top',
    'shift+k': 'messageSelector:top',
    'ctrl+down': 'messageSelector:bottom',
    'shift+down': 'messageSelector:bottom',
    'meta+down': 'messageSelector:bottom',
    'shift+j': 'messageSelector:bottom',
    enter: 'messageSelector:select',
  },
  MessageActions: {
    up: 'messageActions:prev',
    k: 'messageActions:prev',
    down: 'messageActions:next',
    j: 'messageActions:next',
    'meta+up': 'messageActions:top',
    'super+up': 'messageActions:top',
    'meta+down': 'messageActions:bottom',
    'super+down': 'messageActions:bottom',
    'shift+up': 'messageActions:prevUser',
    'shift+down': 'messageActions:nextUser',
    escape: 'messageActions:escape',
    'ctrl+c': 'messageActions:ctrlc',
    enter: 'messageActions:enter',
    c: 'messageActions:c',
    'ctrl+x y': 'messageActions:c',
    p: 'messageActions:p',
  },
  DiffDialog: {
    escape: 'diff:dismiss',
    left: 'diff:previousSource',
    right: 'diff:nextSource',
    up: 'diff:previousFile',
    down: 'diff:nextFile',
    enter: 'diff:viewDetails',
    n: 'diff:nextHunk',
    p: 'diff:previousHunk',
    ']': 'diff:nextFileDetail',
    '[': 'diff:previousFileDetail',
    c: 'diff:copy',
    o: 'diff:openFile',
    a: 'diff:annotate',
    f: 'diff:nextFinding',
    r: 'diff:resolveComments',
    s: 'diff:sendComments',
    x: 'diff:sendAllComments',
  },
  Select: {
    ...SELECT_LIST_KEYS.wheel,
    up: 'select:previous',
    k: 'select:previous',
    down: 'select:next',
    j: 'select:next',
    ...SELECT_LIST_KEYS.ctrlPrevNext,
    ...SELECT_LIST_KEYS.ends,
    enter: 'select:accept',
    escape: 'select:cancel',
  },
  Extensions: {
    space: 'extensions:toggle',
    i: 'extensions:install',
    U: 'extensions:update',
    x: 'extensions:remove',
    b: 'extensions:block',
    o: 'extensions:options',
    a: 'extensions:add-source',
    u: 'extensions:refresh',
    r: 'extensions:reload',
    f: 'extensions:filter',
    P: 'extensions:previous',
  },
  Atlas: {
    'ctrl+l': 'atlas:lookup',
    'ctrl+r': 'atlas:rebind',
  },
} satisfies ShippedRows

export const DEFAULT_BINDINGS: KeybindingBlock[] = Object.entries(SHIPPED_KEYS).map(([context, bindings]) => ({ context, bindings }))
