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
    ['Non-rebindable:', ...NON_REBINDABLE.map(s => `- ${s.key} — ${s.reason}`)],
    [
      'Terminal reserved:',
      ...TERMINAL_RESERVED.map(
        s => `- ${s.key} — ${s.reason}${s.severity === 'error' ? ' (will not work)' : ' (may conflict)'}`,
      ),
    ],
    ['macOS reserved:', ...MACOS_RESERVED.map(s => `- ${s.key} — ${s.reason}`)],
    ['Windows reserved:', ...WINDOWS_RESERVED.map(s => `- ${s.key} — ${s.reason}`)],
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
          'User keybindings live in `~/.mercury/keybindings.json` (or `$MERCURY_CONFIG_DIR/keybindings.json`).',
          'Project keybindings live in `.mercury/keybindings.json` in trusted workspaces and override user bindings; changes hot-reload.',
        ].join('\n'),
        [
          'File shape:',
          '```json',
          JSON.stringify(EXAMPLE, null, 2),
          '```',
          'Each binding value is an action name from the table below, `"command:<slash-command>"` to invoke a slash command, or `null` to unbind a default.',
        ].join('\n'),
        [
          'Keystroke grammar:',
          '- Modifiers: `ctrl`, `alt` (`opt`/`option`), `shift`, `meta`, `cmd` (`command`), joined with `+` (for example `ctrl+k`, `shift+tab`).',
          '- Chords: space-separated keystrokes (for example `ctrl+x t` or `ctrl+x ctrl+k`).',
          '- Named keys: `enter`, `escape`, `tab`, `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`.',
        ].join('\n'),
        [
          'Editing rules:',
          '- Read the existing `keybindings.json` first and merge into its `bindings` array without dropping unrelated entries.',
          '- Keep valid JSON with a top-level `bindings` array and omit `$schema`.',
          '- Warn the user before choosing a terminal or OS reserved shortcut.',
          '- Unbind a default without replacing it by mapping the key to `null` in the matching context.',
          '- Direct the user to `/keys` to inspect live effective bindings and `/health` to verify there are no keybinding warnings.',
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
