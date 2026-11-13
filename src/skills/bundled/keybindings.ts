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

function contextsTable(): string {
  const rows = KEYBINDING_CONTEXTS.map(
    context => `| ${context} | ${KEYBINDING_CONTEXT_DESCRIPTIONS[context]} |`,
  )
  return ['| Context | Description |', '|---|---|', ...rows].join('\n')
}

function actionsTable(): string {
  const byAction = new Map<string, { keys: string[]; context: string }>()
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (typeof action !== 'string') continue
      const entry = byAction.get(action) ?? { keys: [], context: block.context }
      entry.keys.push(key)
      byAction.set(action, entry)
    }
  }
  const graph = ACTION_GRAPH as Record<string, ActionMeta>
  const rows = KEYBINDING_ACTIONS.map(action => {
    const bound = byAction.get(action)
    const meta = graph[action]
    const keys = bound ? bound.keys.join(', ') : '(none)'
    const context = bound ? bound.context : (meta?.contexts.join(' or ') ?? 'Unknown')
    const does = `${meta?.description ?? ''}${meta?.rebindOnly ? ` (no default: ${meta.rebindOnly})` : ''}`
    return `| ${action} | ${keys} | ${context} | ${does} |`
  })
  return ['| Action | Default key(s) | Context | Does |', '|---|---|---|---|', ...rows].join('\n')
}

function reservedTable(): string {
  const lines: string[] = []
  lines.push('Non-rebindable (a config entry is an ERROR):')
  for (const { key, reason } of NON_REBINDABLE) lines.push(`- ${key} — ${reason}`)
  lines.push('')
  lines.push('Terminal-reserved:')
  for (const { key, reason, severity } of TERMINAL_RESERVED) {
    lines.push(`- ${key} — ${reason} (${severity === 'error' ? 'will not work' : 'may conflict'})`)
  }
  lines.push('')
  lines.push('macOS-reserved (errors on macOS):')
  for (const { key, reason } of MACOS_RESERVED) lines.push(`- ${key} — ${reason}`)
  lines.push('')
  lines.push('Windows-reserved (warnings on Windows; ctrl+z and ctrl+\\ swap out for these there):')
  for (const { key, reason } of WINDOWS_RESERVED) lines.push(`- ${key} — ${reason}`)
  return lines.join('\n')
}

function formatExample(): string {
  const example: KeybindingsSchemaType = {
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
  return JSON.stringify(example, null, 2)
}

export function registerKeybindingsSkill(): void {
  registerBundledSkill({
    name: 'keybindings-help',
    description:
      'Use when changing Mercury keyboard shortcuts: rebind an action, add a chord sequence, bind a slash command, unbind a default, or fix /health keybinding errors. Not for settings.json or hooks.',
    allowedTools: ['Read'],
    userInvocable: false,
    isEnabled: () => isKeybindingCustomizationEnabled(),
    getPromptForCommand: async args => {
      const sections = [
        [
          'Layers (lowest to highest; later appends, last binding on a chord wins): shipped defaults → `<config-home>/keybindings.json` (`~/.mercury` or `MERCURY_CONFIG_DIR`) → `.mercury/keybindings.json`. Edits hot-apply via file watcher. `/keybindings` seeds and opens the user file; `/keys` shows and edits the effective map.',
          'Read the target file before editing. Keep at most one block per context (merge into an existing context block; include only contexts with changes) and write only overrides, never defaults.',
        ].join('\n'),
        [
          'File shape:',
          '```json',
          formatExample(),
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
        `Reserved shortcuts:\n${reservedTable()}`,
        `Available contexts:\n${contextsTable()}`,
        `Available actions:\n${actionsTable()}`,
      ]
      const text = args.trim()
        ? [...sections, `User request:\n${args.trim()}`].join('\n\n')
        : sections.join('\n\n')
      return [{ type: 'text', text }]
    },
  })
}
