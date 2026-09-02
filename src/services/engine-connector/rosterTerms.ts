// ============================================================================
//  engine-connector/rosterTerms — the ONE roster definition both
//  implementations answer with.
//
//  A session's skills = its own command table filtered by the product's
//  skill terms (commands.ts getSkillToolCommands' own terms); its MCP roster
//  = its own live connections as name + state rows. The in-process engine
//  answers over its live tables; the daemon-hosted session's PROCESS answers
//  the same way over ITS tables and the daemon projects the rows — so a
//  session inside the concourse lists its OWN skills and servers, never the
//  screen's (parity 1:1).
// ============================================================================
import type { Command } from '../../commands.js'
import type { MCPServerConnection } from '../mcp/types.js'
import type { McpRosterEntryV1, SkillsRosterEntryV1 } from './types.js'

export function skillsRosterOf(commands: readonly Command[], offNames: readonly string[] = []): SkillsRosterEntryV1[] {
  const rows: SkillsRosterEntryV1[] = commands
    .filter(
      command =>
        command.type === 'prompt' &&
        command.source !== 'builtin' &&
        (command.loadedFrom === 'bundled' ||
          command.loadedFrom === 'skills' ||
          command.loadedFrom === 'legacy-commands' ||
          command.hasUserSpecifiedDescription === true ||
          Boolean(command.whenToUse)),
    )
    .map(command => ({
      name: command.name,
      description: command.description ?? '',
      // The tri-state's non-ambient word (L24(5)): listed and loadable by
      // /name, excluded from every model-facing listing — whether the
      // author's own disable-model-invocation or the session kit said so.
      // Absent = ambient. Additive on the wire; old readers ignore it.
      ...(command.disableModelInvocation === true ? { state: 'invocable' as const } : {}),
    }))
  // THE OFF ROWS: the kit-excluded skills the session KNOWS —
  // absent from the table (the body never loaded, so no description), yet
  // listed so the dial has both directions. Display-only: model-facing
  // filters read the TABLE, never this projection. Deduplicated against
  // the table's own names (a name both present and claimed-off keeps its
  // table row — the table is the process truth).
  const present = new Set(rows.map(row => row.name))
  for (const name of offNames) {
    if (present.has(name)) continue
    present.add(name)
    rows.push({ name, description: '', state: 'off' as const })
  }
  return rows
}

/** Mount ∪ dynamic, name-deduplicated (the mount wins), as roster rows. */
export function mcpRosterEntriesOf(
  mount: readonly MCPServerConnection[],
  dynamic: readonly MCPServerConnection[],
): McpRosterEntryV1[] {
  const seen = new Set<string>()
  const rows: McpRosterEntryV1[] = []
  for (const client of [...mount, ...dynamic]) {
    if (seen.has(client.name)) continue
    seen.add(client.name)
    rows.push({
      name: client.name,
      type: client.type,
      // A failed row carries the deadline's honest reason — the same
      // sentence the panel's server menu prints — so the face's line speaks
      // it too; never a second vocabulary.
      ...(client.type === 'failed' && client.error !== undefined && client.error !== ''
        ? { error: client.error }
        : {}),
    })
  }
  return rows
}
