// Mercury's shipped default control scheme. Every action bound here exists in
// the action registry and the registry holds no unreachable action (a gate
// enforces both directions). Block order is part of the table: the loader
// flattens in declaration order and the resolver takes the last match.

import { satisfies } from 'semver'
import type { KeybindingBlock } from './types.js'

// ctrl+v is system paste on Windows.
const IMAGE_PASTE_KEY = process.platform === 'win32' ? 'alt+v' : 'ctrl+v'

/** Modifier-only chords such as shift+tab need virtual-terminal mode on
 *  Windows Terminal; every other platform has it. */
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
      // Declared so the resolver can find them; not rebindable.
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
      'ctrl+t': 'app:toggleTodos',
      'ctrl+x m': 'command:surfaces',
      // Page keys: ctrl+arrows are eaten by the macOS window manager.
      'ctrl+pagedown': 'app:cycleSurfaceForward',
      'ctrl+pageup': 'app:cycleSurfaceBack',
      // The surface strip is linear with hard ends — no wrap-around.
      'shift+right': 'app:surfaceRight',
      'shift+left': 'app:surfaceLeft',
      'ctrl+x p': 'app:commandPalette',
      'ctrl+x f': 'app:fileOpen',
      'ctrl+x g': 'app:contentSearch',
      // command:* dispatches through useCommandKeybindings (the /workbench
      // command itself) — crew:open-board was an action NOTHING registered:
      // /keys printed the chord as bound while pressing it did nothing
      // (TASK-017 S2, keys-atlas-actions-without-handlers).
      'ctrl+x k': 'command:workbench',
      'ctrl+x s': 'command:sessions',
      'ctrl+x c': 'app:openSurfaceSwitcher',
      // The Concourse close chord (the operator's word): a bare printable
      // can never be a board control while any composer is live, so the
      // board's close verb rides the leader as its own completion. Staged:
      // one completed chord stops the highlighted row (it stays, wearing
      // stopped), the same gesture again removes it. Dispatched through the
      // one-slot Concourse seam; anywhere no board stands it declines.
      'ctrl+x ctrl+x': 'concourse:closeSession',
      'ctrl+o': 'app:toggleTranscript',
      // ctrl+shift+o collapses onto ctrl+o's byte on legacy wires; the
      // prefix chord is the portable route — and it is declared LAST so
      // every display walk (getBindingDisplayText reads end-first) teaches
      // the chord that works on every wire, not the one conhost collapses
      // onto the transcript toggle (TASK-017 supplement, SURVIVED).
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
      // enter/↑/↓/ctrl+p/ctrl+n are HANDLED BY THE COMPOSER'S OWN INPUT
      // PATH (useTextInput hardcodes them): registry rows here routed into a
      // void — the keys worked only via the hardcoded path, and the atlas's
      // own ctrl+r rebind wrote a keybindings.json row that was silently
      // inert while ↑ kept working (the Settings-enter precedent below;
      // TASK-017 S2, keys-atlas-actions-without-handlers).
      // Legacy terminals send the control byte; kitty sends the physical key.
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
      // 'enter' is handled by the Settings panel's own raw submit path — a
      // registry row here routed into a void.
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
      // ctrl+f, not ctrl+o: resolution is per-hook (own context, then
      // Global), so a chord Global also binds would fire BOTH actions —
      // the transcript flipped behind the card. Card chords must be
      // globally unbound (the ctrl+e explanation-toggle precedent).
      'ctrl+f': 'confirm:toggleFullPreview',
      'ctrl+d': 'permission:toggleDebug',
      // The plan card's advertised editor chord (TASK-017 S2,
      // exit-plan-editor-hint-dead-both-ways): the card printed 'ctrl+g
      // edit in <editor>' while ctrl+g was bound NOWHERE and the card's
      // chat:externalEditor hook registered in a context no binding could
      // reach. Globally unbound (this block's ctrl+f law), a control chord
      // (never a typeable letter — the PD-1 field-owns-focus class does not
      // apply), and NOT a decision verb: it opens the plan file, settling
      // nothing.
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
      // The jump-to-new pill advertises alt+↓ — the chord must fire (the
      // present-moves law; ctr-4: nothing implemented it and the pill's
      // promise was pointer-only). alt and meta are one logical modifier
      // at the matcher, so this row catches ESC[1;3B everywhere.
      'alt+down': 'scroll:bottom',
      'ctrl+shift+c': 'selection:copy',
      // darwin only: declared unconditionally, the cmd row won the
      // end-first display walk on EVERY platform and the Windows footer
      // taught 'super+c' — a chord no Windows console can deliver at all
      // (super arrives only via the kitty protocol; TASK-017 supplement,
      // SURVIVED). The platform-computed spread is the IMAGE_PASTE_KEY
      // idiom above.
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
      // The surface's own escape route. The rewind surface unmounts the
      // composer and stands the cancel handler down while it shows, so its
      // OWN context must resolve escape — the pick phase would otherwise lean on
      // 'confirm:no', whose escape rows live only in the Settings and
      // Confirmation blocks, and nothing registers those as active contexts
      // while the selector is up: escape resolved to nothing and the
      // operator was stranded.
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
      // Meta is cmd on macOS while the kitty protocol reports super.
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
  // The ModelPicker's effort/context keys are the picker's own raw-input
  // grammar — the registry
  // rows here had NO consumer and routed into a void (inventory S3
  // The registry states reality: those keys are not
  // rebindable through it today.
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
  // The /keys atlas claims its mode chords for the overlay's lifetime. The
  // Atlas context registers only while the atlas is open, and this block
  // sits AFTER Global so the resolver's last-match rule lets these outrank
  // the Global claims on the same chords (ctrl+l app:redraw · ctrl+r
  // history:search) — the atlas's advertised keys must reach the atlas.
  {
    context: 'Atlas',
    bindings: {
      'ctrl+l': 'atlas:lookup',
      'ctrl+r': 'atlas:rebind',
    },
  },
]
