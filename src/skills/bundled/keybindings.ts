import { registerBundledSkill } from '../bundledSkills.js'
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXTS,
  KEYBINDING_CONTEXT_DESCRIPTIONS,
} from '../../keybindings/schema.js'
import type { KeybindingsSchemaType } from '../../keybindings/schema.js'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import {
  NON_REBINDABLE,
  TERMINAL_RESERVED,
  MACOS_RESERVED,
  WINDOWS_RESERVED,
} from '../../keybindings/reservedShortcuts.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import { ACTION_GRAPH, type ActionMeta } from '../../keybindings/actionGraph.js'
import { DOCS_LINE } from '../../keybindings/writeBindings.js'

function buildContextTable(): string {
  const rows = ['| Context | Description |', '|---|---|']
  for (const context of KEYBINDING_CONTEXTS) {
    rows.push(`| ${context} | ${KEYBINDING_CONTEXT_DESCRIPTIONS[context]} |`)
  }
  return rows.join('\n')
}

function buildActionTable(): string {
  const defaultsByAction = new Map<string, { keys: string[]; context: string }>()
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (typeof action !== 'string') continue
      const existing = defaultsByAction.get(action)
      if (existing) {
        existing.keys.push(key)
      } else {
        defaultsByAction.set(action, { keys: [key], context: block.context })
      }
    }
  }
  const graph: Partial<Record<string, ActionMeta>> = ACTION_GRAPH
  const rows = ['| Action | Default key(s) | Context | Does |', '|---|---|---|---|']
  for (const action of KEYBINDING_ACTIONS) {
    const defaults = defaultsByAction.get(action)
    const meta = graph[action]
    const keys = defaults ? defaults.keys.join(', ') : '(none)'
    const context = defaults ? defaults.context : meta ? meta.contexts.join(' or ') : 'Unknown'
    const baseDesc = meta?.description ?? ''
    const does = meta?.rebindOnly ? `${baseDesc} (no default: ${meta.rebindOnly})` : baseDesc
    rows.push(`| ${action} | ${keys} | ${context} | ${does} |`)
  }
  return rows.join('\n')
}

function buildReservedSection(): string {
  const groups = [
    ['Non-rebindable (a config entry is an ERROR):', ...NON_REBINDABLE.map(s => `- ${s.key} — ${s.reason}`)],
    [
      'Terminal-reserved:',
      ...TERMINAL_RESERVED.map(
        s => `- ${s.key} — ${s.reason} (${s.severity === 'error' ? 'will not work' : 'may conflict'})`,
      ),
    ],
    ['macOS-reserved (errors on macOS):', ...MACOS_RESERVED.map(s => `- ${s.key} — ${s.reason}`)],
    [
      'Windows-reserved (warnings on Windows; ctrl+z and ctrl+\\ swap out for these there):',
      ...WINDOWS_RESERVED.map(s => `- ${s.key} — ${s.reason}`),
    ],
  ]
  return groups.map(group => group.join('\n')).join('\n\n')
}

const EXAMPLE: KeybindingsSchemaType = {
  $docs: DOCS_LINE,
  bindings: [
    {
      context: 'Chat',
      bindings: {
        'ctrl+k': 'chat:undo',
        'ctrl+x t': 'command:appearance',
        'ctrl+s': null,
      },
    },
  ],
}

export function registerKeybindingsSkill(): void {
  registerBundledSkill({
    name: 'keybindings-help',
    description:
      'Use when changing Mercury keyboard shortcuts: rebind an action, add a chord sequence, bind a slash command, unbind a default, or fix /health keybinding errors. Not for settings.json or hooks.',
    allowedTools: ['Read'],
    userInvocable: false,
    isEnabled: () => isKeybindingCustomizationEnabled(),
    async getPromptForCommand(args: string) {
      const sections = [
        [
          'Layers (lowest to highest; later appends, last binding on a chord wins): shipped defaults → <config-home>/keybindings.json (~/.mercury or `MERCURY_CONFIG_DIR`) → .mercury/keybindings.json. Edits hot-apply via file watcher. `/keybindings` seeds and opens the user file; `/keys` shows and edits the effective map.',
          'Read the target file before editing. Keep at most one block per context (merge into an existing context block; include only contexts with changes) and write only overrides, never defaults.',
        ].join('\n'),
        [
          'File shape:',
          '```json',
          JSON.stringify(EXAMPLE, null, 2),
          '```',
          'Values: a built-in action id from the table below, `command:<name>` (runs `/<name>` in `Chat` or `Global`), or `null` (unbinds). Never add `$schema`: Mercury publishes none for this file, and foreign keybinding schemas reject Mercury action ids.',
        ].join('\n'),
        [
          'Keystroke grammar (case-insensitive):',
          '- Modifiers (`+`): `ctrl` (`control`), `alt` (`opt`, `option`), `shift`, `meta`, `cmd` (`command`, `super`, `win` — distinct from `meta`).',
          '- Keys: `esc`/`escape`, `enter`/`return`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right` (or arrow glyphs), `pageup`, `pagedown`, `home`, `end`.',
          '- Chords: space-separated keystrokes (e.g. `"ctrl+x p"`). Pending chords wait 2s (plus a 2s grace window where a completing key finishes the chord while other keys type normally); `Escape` or a non-matching key cancels. Prefix chords shadow exact bindings on the prefix key, so never bind an action to a chord prefix.',
        ].join('\n'),
        [
          'Editing & verification:',
          '- Rebind = bind the new key to the action and set the old key to `null` in that context.',
          '- `null` masks the action without leaking modifier/control chords to lower contexts; printable keys pass through.',
          '- Broken layers warn and are skipped without breaking defaults or other layers.',
          '- Check reserved shortcuts below; prefer `ctrl` chords or chord sequences for terminal portability (`/keys` shows what the active terminal delivers).',
          '- `/health` reports Keybindings findings (`parse_error`, `duplicate`, `reserved`, `invalid_context`, `invalid_action`: errors cannot apply, warnings flag conflicts) and `/keys` shows the live map.',
        ].join('\n'),
        ['Reserved shortcuts:', buildReservedSection()].join('\n'),
        ['Available contexts:', buildContextTable()].join('\n'),
        ['Available actions:', buildActionTable()].join('\n'),
      ]
      const trimmed = args.trim()
      if (trimmed !== '') {
        sections.push(['User request:', trimmed].join('\n'))
      }
      return [{ type: 'text', text: sections.join('\n\n') }]
    },
  })
}
