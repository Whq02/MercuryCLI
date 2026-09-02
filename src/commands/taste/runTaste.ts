import type { LocalCommandCall } from '../../types/command.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { isScribeModeOn } from '../../utils/scribeMode.js'
import {
  type TasteKind,
  buildEpisode,
  captureSnapshot,
  lessonFor,
  promoteLessons,
  tasteLoopEnabled,
  writeEpisode,
} from '../../memdir/tasteLoop.js'

// `/meh <complaint>` / `/good <praise>` — the Taste Loop capture commands.
// Each captures a redacted, bounded recent-session snapshot, classifies the
// friction/success, persists an episode, refreshes promotions, and echoes back
// what was logged + the likely class + one next adjustment. Both are thin
// wrappers over runTasteCommand differing only by `kind`. Flag-gated (off ⇒ the
// commands are absent ⇒ byte-identical); see src/memdir/tasteLoop.ts.

const basename = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p

/** Cheap, robust reads of the active mode flags for the snapshot. */
function activeModes(context: Parameters<LocalCommandCall>[1]): string[] {
  const modes: string[] = []
  modes.push('fork')
  try {
    const app = context.getAppState?.()
    const mode = app?.toolPermissionContext?.mode
    if (mode && mode !== 'default') modes.push(mode)
    if (app?.supercode === true) modes.push('supercode')
  } catch {
    // getAppState unavailable in this context — modes stay best-effort.
  }
  try {
    if (isScribeModeOn()) modes.push('scribe')
  } catch {}
  return modes
}

export async function runTasteCommand(
  kind: TasteKind,
  args: string,
  context: Parameters<LocalCommandCall>[1],
  // Injectable for tests; production resolves the real per-project memory dir.
  memoryDirOverride?: string,
): Promise<{ type: 'text'; value: string }> {
  const verb = kind === 'meh' ? 'meh' : 'good'
  if (!tasteLoopEnabled()) {
    return {
      type: 'text',
      value: `The Taste Loop is off this session (MERCURY_TASTE_LOOP=0) — nothing logged.`,
    }
  }
  if (!isAutoMemoryEnabled()) {
    return {
      type: 'text',
      value: `Auto-memory is disabled this session — cannot log a /${verb} episode.`,
    }
  }
  const text = (args ?? '').trim()
  if (!text) {
    const hint =
      kind === 'meh'
        ? 'what felt off about the last stretch'
        : 'what worked well in the last stretch'
    return { type: 'text', value: `Usage: \`/${verb} <${hint}>\`` }
  }

  const snapshot = captureSnapshot(context.messages ?? [], {
    sessionId: String(getSessionId()),
    cwd: getCwd(),
    project: getProjectRoot(),
    modes: activeModes(context),
  })
  const episode = buildEpisode(kind, text, snapshot, new Date().toISOString())

  const memoryDir = memoryDirOverride ?? getAutoMemPath()
  try {
    await writeEpisode(memoryDir, episode)
  } catch {
    return {
      type: 'text',
      value: `Could not persist the /${verb} episode (memory dir not writable). Classified it as ${episode.cls} but nothing was saved.`,
    }
  }

  // Refresh promotions; a class that has now repeated >= threshold becomes a
  // candidate lesson surfaced in future turns.
  let promotedNote = ''
  try {
    const { promoted } = await promoteLessons(memoryDir)
    const mine = promoted.find(l => l.kind === kind && l.cls === episode.cls)
    if (mine) {
      promotedNote = `\nThis pattern has repeated ×${mine.count} — it's now a candidate lesson in TASTE.md and will surface (precisely, throttled) in future turns.`
    }
  } catch {
    // promotion is best-effort; the episode is already saved.
  }

  const why = episode.signals.slice(0, 2).join('; ') || 'no strong signal — logged as-is'
  const adjustLabel = kind === 'meh' ? 'Next adjustment' : 'Keep doing'
  const snap = `${snapshot.turns.length} turn(s) · ${snapshot.tools.length} tool(s)${
    snapshot.modes.length ? ` · modes ${snapshot.modes.join(',')}` : ''
  } · ${basename(snapshot.project)}`

  return {
    type: 'text',
    value:
      `Logged a /${verb} → ${episode.cls} (${why}).\n` +
      `Snapshot: ${snap}.\n` +
      `${adjustLabel}: ${lessonFor(kind, episode.cls)}` +
      promotedNote,
  }
}

export const mehCall: LocalCommandCall = (args, context) =>
  runTasteCommand('meh', args, context)

export const goodCall: LocalCommandCall = (args, context) =>
  runTasteCommand('good', args, context)
