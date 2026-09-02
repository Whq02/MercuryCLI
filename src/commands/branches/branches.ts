import type { LocalCommandCall } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { lanesEnabled, listLanes } from '../../services/contextLanes/lanes.js'

// `/branches` — the side-lane listing for THIS session (as parent or child).
export const call: LocalCommandCall = async (_args, _context) => {
  if (!lanesEnabled()) {
    return { type: 'text', value: 'Side lanes are disabled (MERCURY_LANES=0).' }
  }
  const sessionId = String(getSessionId())
  const asParent = listLanes({ parentSessionId: sessionId })
  const asChild = listLanes({ childSessionId: sessionId })
  if (asParent.length === 0 && asChild.length === 0) {
    return {
      type: 'text',
      value:
        'No side lanes for this session. Start one with `/branch <goal>` — it forks the conversation with a bounded side goal and returns a typed handoff.',
    }
  }
  const lines: string[] = []
  if (asChild.length > 0) {
    const lane = asChild[0]!
    lines.push(
      `THIS session is lane ${lane.id} (${lane.status}) — goal: ${lane.goal}`,
      lane.status === 'active'
        ? '  finish with `/branch return <answer>`'
        : `  handoff ${lane.handoff?.promoted ? 'promoted' : 'recorded — promote from the parent'}`,
      '',
    )
  }
  if (asParent.length > 0) {
    lines.push(`Lanes parented by this session (${asParent.length}):`)
    for (const lane of asParent) {
      const handoff = lane.handoff
      lines.push(
        `  ${lane.id} — ${lane.status} · ${lane.goal}`,
        ...(handoff
          ? [
              `    answer: ${handoff.answer.slice(0, 120)}${handoff.promoted ? ' (promoted)' : ` — promote with \`/branch promote ${lane.id}\``}`,
              ...(handoff.changedPaths.length > 0
                ? [`    changed (observed): ${handoff.changedPaths.slice(0, 5).join(', ')}${handoff.changedPaths.length > 5 ? ` (+${handoff.changedPaths.length - 5})` : ''}`]
                : []),
            ]
          : lane.status === 'active'
            ? [`    resume it: claude -r ${lane.childSessionId}`]
            : []),
        `    ref: mercury://lane/${lane.id}`,
      )
    }
  }
  return { type: 'text', value: lines.join('\n') }
}
