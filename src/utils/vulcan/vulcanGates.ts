
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { findGodotProjectRoot } from '../../services/lsp/godotLane.js'
import { logForDebugging } from '../debug.js'

export const VULCAN_DEFAULT_PORT = 6010

export function vulcanEnabled(): boolean {
  return flagEnabled('MERCURY_GODOT_TOOLS')
}

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

export function vulcanLiteMode(): boolean {
  return flagEnabled('MERCURY_GODOT_TOOLS_LITE')
}

export function vulcanTokenOverride(): string | undefined {
  const raw = flagEnv('MERCURY_GODOT_TOOLS_TOKEN')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}


export function getVulcanSection(): string | null {
  if (!vulcanEnabled()) return null
  if (findGodotProjectRoot() === undefined) return null
  return [
    '# Godot control surface (VULCAN)',
    'The Godot tool drives the running editor directly over a loopback bridge. Editor state is the source of truth — query first (scene_tree, node_get, editor_state), then mutate; every mutation is one undo step in the editor (Ctrl+Z reverts). Prefer scene/node/resource ops over hand-editing .tscn/.tres text. Play-test natively: scene_play, runtime_* inspection, input simulation, then scene_stop. GDScript SYMBOL work (outline, definitions, rename) stays with the LSP tool; BREAKPOINT debugging stays with the Debug tool\'s godot adapter. Save durable project facts (scene conventions, physics layers, autoload roles) to memory.',
  ].join('\n')
}

export function getVulcanDoctrineLine(): string | null {
  if (!vulcanEnabled()) return null
  if (findGodotProjectRoot() === undefined) return null
  return '- The VULCAN Godot surface is armed here: prefer the Godot tool (editor state, scene/node ops, play-test) over text-editing scene/resource files — editor state outranks file guesses.'
}

export function getVulcanHarnessMapLine(): string | null {
  if (!vulcanEnabled()) return null
  return '- Godot control (VULCAN) is ARMED: the Godot tool drives the editor (scenes, nodes, play-test, runtime inspection) over the loopback bridge; /health shows editor reachability.'
}
