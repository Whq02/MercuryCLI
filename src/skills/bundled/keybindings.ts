// ============================================================================
//  src/skills/bundled/keybindings.ts — keybindings-help: a model-invoked
//  reference over the keybindings.json layers, with three tables GENERATED
//  from the live registries so the reference can never drift from the code.
// ============================================================================
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
  // Invert the default-binding blocks into action → (keys, context).
  const byAction = new Map<string, { keys: string[]; context: string }>()
  for (const block of DEFAULT_BINDINGS) {
    for (const [key, action] of Object.entries(block.bindings)) {
      if (typeof action !== 'string') continue
      const entry = byAction.get(action) ?? { keys: [], context: block.context }
      entry.keys.push(key)
      byAction.set(action, entry)
    }
  }
  // Context and meaning come from the action graph — the one interaction
  // authority — so an action that ships without a default still names the
  // contexts its consumers register, and the reason it has no default key.
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
  // The Windows rows were generated NOWHERE (TASK-017 supplement,
  // SURVIVED): the reference printed the POSIX tables alone, so a Windows
  // operator read ctrl+z as "Unix process suspend" and no warning at all
  // for the chords WT/conhost actually eat. On Windows the two POSIX
  // signal rows above are replaced by these.
  lines.push('Windows-reserved (warnings on Windows; ctrl+z and ctrl+\\ swap out for these there):')
  for (const { key, reason } of WINDOWS_RESERVED) lines.push(`- ${key} — ${reason}`)
  return lines.join('\n')
}

/** The format example, serialised from a value TYPED BY THE REAL SCHEMA —
 *  a drifted example fails the typecheck. Its $docs is the writer's own
 *  DOCS_LINE, the same string /keys stamps into real files. */
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
      'Use when the user asks to change Mercury keyboard shortcuts: rebind an action, add a chord sequence, bind a slash command to a key, unbind a default, or fix keybinding errors reported by /health. Carries the file layers, the keystroke grammar, and the generated action/context/reserved tables.',
    allowedTools: ['Read'],
    userInvocable: false,
    isEnabled: () => isKeybindingCustomizationEnabled(),
    getPromptForCommand: async args => {
      const sections = [
        // The estate.
        [
          'You are editing Mercury keyboard shortcuts.',
          'Bindings resolve in three layers: the shipped defaults, then keybindings.json in the config home (~/.mercury, or whatever MERCURY_CONFIG_DIR names), then a project-level .mercury/keybindings.json when the project carries one. Later layers append; on the same chord the LAST binding wins, which is what makes user entries override defaults.',
          'A file watcher hot-applies edits to a running session — no restart. The /keybindings command creates the user file from a starter template and opens it in the editor; the /keys atlas shows the live effective table and can rebind in place.',
          'Read the target file before editing it, and keep one block per context: merge new entries into the block that already owns that context instead of appending a duplicate block. Write only what changes — never restate defaults.',
        ].join('\n'),
        // File shape.
        [
          'File shape (this example is serialised from the real schema; a drifted example would fail the build):',
          '```json',
          formatExample(),
          '```',
          'Each entry maps a keystroke pattern to one of three values: a built-in action id from the actions table, `command:<name>` to run that slash command as if typed, or null to unbind a default.',
          'Do not add a $schema key: Mercury publishes no schema for this file, and the only published schema under this filename describes another product\'s action vocabulary, so an editor would flag every Mercury action id as invalid.',
        ].join('\n'),
        // Keystroke grammar.
        [
          'Keystroke grammar (case-insensitive):',
          '- modifiers joined with +: ctrl (control), alt (opt, option), shift, meta, and cmd (command, super, win) — cmd is its own modifier, not a spelling of meta.',
          '- named keys and aliases: esc/escape, enter/return, tab, space, backspace, delete, up, down, left, right (arrow glyphs also parse), pageup, pagedown, home, end.',
          '- a chord sequence is keystrokes separated by spaces, e.g. "ctrl+x p". A pending chord has no timer: it waits until a keystroke completes it, and Escape or any non-matching key cancels it.',
          '- longer chords win: a sequence prefix shadows an exact binding on the same keystroke, so never give a chord prefix its own action — that action would never fire.',
        ].join('\n'),
        // Editing law.
        [
          'Editing rules:',
          '- Rebind = two entries in that context\'s block: the new pattern set to the action, the old pattern set to null.',
          '- Unbinding with null masks the action, not the typing: a nulled modifier or control chord is still consumed (it never leaks to a lower-priority context), while printable keys pass through to the input.',
          '- A context block belongs in the file only when something in that context changes.',
          '- A broken layer degrades to warnings and is ignored; it never poisons the defaults or the other layer.',
          '- Check requested keys against the reserved lists below, and prefer plain ctrl chords or chord sequences for portability — some modifier combinations only arrive in terminals with virtual-key encoding, and /keys knows what the current terminal delivers.',
        ].join('\n'),
        // Verification.
        [
          'After writing: /health reports the keybindings section and /keys shows the effective map. Findings print as "Keybinding error/warning: …" lines, one per finding, each with a fix suggestion. The finding kinds are parse_error, duplicate, reserved, invalid_context and invalid_action; errors mark entries that cannot take effect, warnings mark likely conflicts.',
        ].join('\n'),
        // Reserved shortcuts (generated).
        `Reserved shortcuts:\n${reservedTable()}`,
        // Contexts (generated).
        `Available contexts:\n${contextsTable()}`,
        // Actions (generated).
        `Available actions:\n${actionsTable()}`,
      ]
      const text = args.trim()
        ? [...sections, `User request:\n${args.trim()}`].join('\n\n')
        : sections.join('\n\n')
      return [{ type: 'text', text }]
    },
  })
}
