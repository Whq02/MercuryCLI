// ============================================================================
//  vulcanGates — the VULCAN Godot editor-control surface's gate module.
//
//  VULCAN is opt-in default-OFF (MERCURY_GODOT_TOOLS=1): the `Godot` tool joins
//  the catalog, the loopback client arms, and the behavioral seams (harness
//  map · prompt section · subagent doctrine) splice — each gating LIVE here,
//  so a boot-menu toggle mechanically shifts every agent surface and OFF is
//  byte-identical (no tool, no prompt bytes, no token file, no addon writes).
//
//  Sandbox posture (hardened ABOVE the editor's own unauthenticated LSP/DAP
//  listeners): loopback-only by construction (the client API takes a port,
//  never a host) + a per-session token exchanged via a project-private file.
// ============================================================================

import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { findGodotProjectRoot } from '../../services/lsp/godotLane.js'
import { logForDebugging } from '../debug.js'

export const VULCAN_DEFAULT_PORT = 6010

/** Master gate (opt-in: MERCURY_GODOT_TOOLS=1). LIVE env read every call. */
export function vulcanEnabled(): boolean {
  return flagEnabled('MERCURY_GODOT_TOOLS')
}

/** Catalog seam for tools.ts (the DebugTool pattern). The tool registers
 *  whenever the flag is armed — project/editor absence answers with teaching
 *  notes at call time (the honest-degradation contract), never a ghost tool
 *  in a non-Godot repo: the schema/prompt only advertise when a project.godot
 *  root exists too. */
export function vulcanToolCatalogEnabled(): boolean {
  return vulcanEnabled() && findGodotProjectRoot() !== undefined
}

export function vulcanPort(): number {
  const raw = flagEnv('MERCURY_GODOT_TOOLS_PORT')
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed
  if (raw && raw.trim().length > 0) {
    logForDebugging(`[VULCAN] ignoring invalid port '${raw}' — using ${VULCAN_DEFAULT_PORT}`)
  }
  return VULCAN_DEFAULT_PORT
}

/** Lite mode: the 76-op core subset is advertised; non-core ops answer with a
 *  teaching refusal before reaching the wire. */
export function vulcanLiteMode(): boolean {
  return flagEnabled('MERCURY_GODOT_TOOLS_LITE')
}

/** Proof/embedder seam: overrides the per-session token (never logged). */
export function vulcanTokenOverride(): string | undefined {
  const raw = flagEnv('MERCURY_GODOT_TOOLS_TOKEN')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}

// ── behavioral seams (all self-gating; OFF ⇒ null ⇒ byte-identical) ─────────

/** The system-prompt section (spliced at the modeSections seam in prompts.ts).
 *  Facts + routing only — behavior rules belong to gates. */
export function getVulcanSection(): string | null {
  if (!vulcanEnabled()) return null
  if (findGodotProjectRoot() === undefined) return null
  return [
    '# Godot control surface (VULCAN)',
    'The Godot tool drives the running editor directly over a loopback bridge. Editor state is the source of truth — query first (scene_tree, node_get, editor_state), then mutate; every mutation is one undo step in the editor (Ctrl+Z reverts). Prefer scene/node/resource ops over hand-editing .tscn/.tres text. Play-test natively: scene_play, runtime_* inspection, input simulation, then scene_stop. GDScript SYMBOL work (outline, definitions, rename) stays with the LSP tool; BREAKPOINT debugging stays with the Debug tool\'s godot adapter. Save durable project facts (scene conventions, physics layers, autoload roles) to memory.',
  ].join('\n')
}

/** One-line subagent-doctrine splice (the LSP-doctrine-line pattern). */
export function getVulcanDoctrineLine(): string | null {
  if (!vulcanEnabled()) return null
  if (findGodotProjectRoot() === undefined) return null
  return '- The VULCAN Godot surface is armed here: prefer the Godot tool (editor state, scene/node ops, play-test) over text-editing scene/resource files — editor state outranks file guesses.'
}

/** The harness-map line (armed-lane announcement, #182 pattern). */
export function getVulcanHarnessMapLine(): string | null {
  if (!vulcanEnabled()) return null
  return '- Godot control (VULCAN) is ARMED: the Godot tool drives the editor (scenes, nodes, play-test, runtime inspection) over the loopback bridge; /health shows editor reachability.'
}
