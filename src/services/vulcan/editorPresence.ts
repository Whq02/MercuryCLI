
import { probeGodotEditorReachable } from '../lsp/godotLane.js'
import {
  describeGodotProcess,
  editorsForProject,
  runningGodotProcesses,
  type GodotProcess,
} from './godotProcessCensus.js'

export type GodotEditorPresenceState = 'no-editor' | 'editor-unbridged' | 'bridge-up'

export interface GodotEditorPresence {
  state: GodotEditorPresenceState
  port: number
  reachable: boolean
  censusOk: boolean
  editors: GodotProcess[]
  processes: GodotProcess[]
  words: string
}

export interface AddonPresenceFacts {
  installed: boolean
  enabled: boolean
}

export const PRESENCE_WORDS: Record<GodotEditorPresenceState, string> = {
  'no-editor': 'no editor running',
  'editor-unbridged': 'editor running, bridge dark (open but unbridged)',
  'bridge-up': 'bridge up',
}

export function derivePresence(
  port: number,
  reachable: boolean,
  census: { ok: boolean; processes: GodotProcess[] },
  projectRoot: string,
): GodotEditorPresence {
  const editors = editorsForProject(census.processes, projectRoot)
  const state: GodotEditorPresenceState = reachable
    ? 'bridge-up'
    : editors.length > 0
      ? 'editor-unbridged'
      : 'no-editor'
  let words = PRESENCE_WORDS[state]
  if (state === 'editor-unbridged') {
    const e = editors[0]!
    words = `editor running (pid ${e.pid}${e.headless ? ', headless' : ''}${e.project ? '' : ', project unknown from its command line'}), bridge dark — open but unbridged`
  } else if (state === 'no-editor' && !census.ok) {
    words = 'no editor answering, and the process table could not be read (a running editor would not be seen)'
  } else if (state === 'no-editor' && census.processes.some(p => p.editor)) {
    words = `no editor running on this project (${census.processes.filter(p => p.editor).length} on other projects)`
  }
  return { state, port, reachable, censusOk: census.ok, editors, processes: census.processes, words }
}

export async function probeGodotEditorPresence(
  projectRoot: string,
  port: number,
  census?: { ok: boolean; processes: GodotProcess[] },
): Promise<GodotEditorPresence> {
  const [reachable, seen] = await Promise.all([
    probeGodotEditorReachable(port),
    census ? Promise.resolve(census) : takeCensus(),
  ])
  return derivePresence(port, reachable, seen, projectRoot)
}

export async function takeCensus(): Promise<{ ok: boolean; processes: GodotProcess[] }> {
  try {
    const processes = await runningGodotProcesses()
    return { ok: true, processes }
  } catch {
    return { ok: false, processes: [] }
  }
}

export function presenceNudge(presence: GodotEditorPresence, addon: AddonPresenceFacts): string {
  if (presence.state === 'bridge-up') return ''
  if (presence.state === 'no-editor') {
    const first = !addon.installed
      ? 'op:"vulcan_install" writes the addon and enables it; then '
      : !addon.enabled
        ? 'the addon is on disk but not enabled in project.godot — op:"vulcan_install" enables it; then '
        : ''
    return `${first}open the project in the Godot editor (godot --editor --path <project>; --headless works) — enabled plugins load at editor startup`
  }
  const editor = presence.editors[0]!
  const load = editor.headless
    ? `the running editor is headless (pid ${editor.pid}) and never sees a focus event: restart it — ${editor.executable} --editor --headless --path <project>`
    : 'click into the editor window: Godot rescans on focus and offers "Files have been modified outside Godot" — choose "Reload from disk" (never "Ignore external changes", which resaves the editor\'s own copy over the install edit); that reload loads no plugin by itself, so then enable "Mercury VULCAN" under Project > Project Settings > Plugins, or use Project > Reload Current Project (a restart; plugins load at startup)'
  const first = !addon.installed
    ? 'op:"vulcan_install" writes the addon and enables it; then '
    : !addon.enabled
      ? 'the addon is on disk but not enabled in project.godot — op:"vulcan_install" enables it; then '
      : 'the plugin is installed and enabled on disk but this editor has not loaded it — '
  return `${first}${load}. Mercury cannot reach an unbridged editor (the LSP/DAP ports cannot toggle plugins); once a bridge is up, vulcan_install reloads the plugin over it by itself`
}

export function staticCapsuleSource(presence: GodotEditorPresence): string {
  return `static (${presence.words} — derived from project files; unsaved editor state and uid:// resolution need the live editor)`
}

export function editorOnlySliceWords(presence: GodotEditorPresence): string {
  switch (presence.state) {
    case 'editor-unbridged':
      return '(editor open but unbridged)'
    case 'bridge-up':
      return '(not read from files — the live editor answers project_capsule)'
    case 'no-editor':
      return '(no editor running)'
  }
}

export function describePresenceProcesses(presence: GodotEditorPresence): string[] {
  return presence.processes.map(describeGodotProcess)
}
