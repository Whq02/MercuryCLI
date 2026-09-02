
import { satisfies } from 'semver'
import type { KeybindingBlock } from './types.js'

const IMAGE_PASTE_KEY = process.platform === 'win32' ? 'alt+v' : 'ctrl+v'

function terminalSupportsVtMode(): boolean {
  if (process.platform !== 'win32') return true
  const bunVersion = process.versions.bun
  if (bunVersion) return satisfies(bunVersion, '>=1.2.23')
  return satisfies(process.versions.node, '>=22.17.0 <23.0.0 || >=24.2.0')
}

const MODE_CYCLE_KEY = terminalSupportsVtMode() ? 'shift+tab' : 'meta+m'

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
      'ctrl+t': 'app:toggleTodos',
      'ctrl+x m': 'command:surfaces',
      'ctrl+pagedown': 'app:cycleSurfaceForward',
      'ctrl+pageup': 'app:cycleSurfaceBack',
      'shift+right': 'app:surfaceRight',
      'shift+left': 'app:surfaceLeft',
      'ctrl+x p': 'app:commandPalette',
      'ctrl+x f': 'app:fileOpen',
      'ctrl+x g': 'app:contentSearch',
      'ctrl+x k': 'command:workbench',
      'ctrl+x s': 'command:sessions',
      'ctrl+x c': 'app:openSurfaceSwitcher',
      'ctrl+x ctrl+x': 'concourse:closeSession',
      'ctrl+o': 'app:toggleTranscript',
      'ctrl+shift+o': 'app:toggleTeammatePreview',
      'ctrl+x o': 'app:toggleTeammatePreview',
      'ctrl+r': 'history:search',
    },
  },
  {
    context: 'Chat',
    bindings: {
      escape: 'chat:cancel',
      'ctrl+x ctrl+k': 'chat:killAgents',
      [MODE_CYCLE_KEY]: 'chat:cycleMode',
      'meta+p': 'chat:modelPicker',
      'meta+t': 'chat:thinkingToggle',
      'meta+left': 'chat:flipSessionBack',
      'meta+right': 'chat:flipSessionForward',
      'ctrl+_': 'chat:undo',
      'ctrl+shift+-': 'chat:undo',
      'ctrl+x ctrl+r': 'chat:redo',
      'ctrl+x ctrl+e': 'chat:externalEditor',
      'ctrl+s': 'chat:stash',
      [IMAGE_PASTE_KEY]: 'chat:imagePaste',
      'shift+up': 'chat:messageActions',
    },
  },
  {
    context: 'Autocomplete',
    bindings: {
      tab: 'autocomplete:accept',
      escape: 'autocomplete:dismiss',
      up: 'autocomplete:previous',
      down: 'autocomplete:next',
    },
  },
  {
    context: 'Settings',
    bindings: {
      escape: 'confirm:no',
      up: 'select:previous',
      down: 'select:next',
      k: 'select:previous',
      j: 'select:next',
      'ctrl+p': 'select:previous',
      'ctrl+n': 'select:next',
      space: 'select:accept',
      r: 'settings:retry',
    },
  },
  {
    context: 'Confirmation',
    bindings: {
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
  },
  {
    context: 'Tabs',
    bindings: {
      tab: 'tabs:next',
      right: 'tabs:next',
      'shift+tab': 'tabs:previous',
      left: 'tabs:previous',
    },
  },
  {
    context: 'Transcript',
    bindings: {
      'ctrl+e': 'transcript:toggleShowAll',
      'ctrl+c': 'transcript:exit',
      escape: 'transcript:exit',
      q: 'transcript:exit',
    },
  },
  {
    context: 'HistorySearch',
    bindings: {
      'ctrl+r': 'historySearch:next',
      escape: 'historySearch:accept',
      tab: 'historySearch:accept',
      'ctrl+c': 'historySearch:cancel',
      enter: 'historySearch:execute',
    },
  },
  {
    context: 'Task',
    bindings: {
      'ctrl+b': 'task:background',
    },
  },
  {
    context: 'ThemePicker',
    bindings: {
      'ctrl+t': 'theme:toggleSyntaxHighlighting',
    },
  },
  {
    context: 'Scroll',
    bindings: {
      pageup: 'scroll:pageUp',
      pagedown: 'scroll:pageDown',
      wheelup: 'scroll:lineUp',
      wheeldown: 'scroll:lineDown',
      'ctrl+home': 'scroll:top',
      'ctrl+end': 'scroll:bottom',
      'alt+down': 'scroll:bottom',
      'ctrl+shift+c': 'selection:copy',
      ...(process.platform === 'darwin' ? { 'cmd+c': 'selection:copy' } : {}),
    },
  },
  {
    context: 'Help',
    bindings: {
      escape: 'help:dismiss',
    },
  },
  {
    context: 'Attachments',
    bindings: {
      right: 'attachments:next',
      left: 'attachments:previous',
      backspace: 'attachments:remove',
      delete: 'attachments:remove',
      down: 'attachments:exit',
      escape: 'attachments:exit',
    },
  },
  {
    context: 'Footer',
    bindings: {
      up: 'footer:up',
      'ctrl+p': 'footer:up',
      down: 'footer:down',
      'ctrl+n': 'footer:down',
      right: 'footer:next',
      left: 'footer:previous',
      enter: 'footer:openSelected',
      escape: 'footer:clearSelection',
    },
  },
  {
    context: 'MessageSelector',
    bindings: {
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
  },
  {
    context: 'MessageActions',
    bindings: {
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
      p: 'messageActions:p',
    },
  },
  {
    context: 'DiffDialog',
    bindings: {
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
  },
  {
    context: 'Select',
    bindings: {
      up: 'select:previous',
      k: 'select:previous',
      down: 'select:next',
      j: 'select:next',
      'ctrl+p': 'select:previous',
      'ctrl+n': 'select:next',
      enter: 'select:accept',
      escape: 'select:cancel',
    },
  },
  {
    context: 'Extensions',
    bindings: {
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
  },
  {
    context: 'Atlas',
    bindings: {
      'ctrl+l': 'atlas:lookup',
      'ctrl+r': 'atlas:rebind',
    },
  },
]
