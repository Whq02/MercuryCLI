import type { LocalCommandCall } from '../../types/command.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { buildRepoSurfaceMap } from '../../utils/cockpit/repoSurfaceMap.js'

// /orient — the inspectable project surface.
//
// Bare: the fresh surface map (bounded, <100ms) plus — when the
// project-intelligence slice is on — the snapshot's generation/freshness,
// current change state, the operator's context marks, and the mercury://
// drill-in refs. Verbs: `pin <path>` / `drop <path>` / `clear <path>`
// correct the working set through the capsule's operator tier; `pins`
// lists the marks. MERCURY_PROJECT_INTEL=0 ⇒ the bare surface-map output,
// byte-identical (the verbs answer with the disabled note).

function intelSection(): string | null {
  try {
    const { projectIntelEnabled } =
      require('../../services/projectIntel/contracts.js') as typeof import('../../services/projectIntel/contracts.js')
    if (!projectIntelEnabled()) return null
    const { getProjectSnapshot } =
      require('../../services/projectIntel/snapshot.js') as typeof import('../../services/projectIntel/snapshot.js')
    const { getContextMarks } =
      require('../../services/projectIntel/pins.js') as typeof import('../../services/projectIntel/pins.js')
    const { processOwnerForLane } =
      require('../../services/run/resolveOwner.js') as typeof import('../../services/run/resolveOwner.js')
    const read = getProjectSnapshot(getOriginalCwd())
    if (!read) return null
    const { snapshot, from } = read
    const gen = snapshot.generation
    const marks = getContextMarks(processOwnerForLane(null))
    const lines: string[] = ['', '## Project intelligence']
    lines.push(
      `- generation \`${gen.treeDigest?.slice(0, 12) ?? 'no-digest'}\` · ${from} · base build ${gen.buildMs}ms${gen.branch ? ` · ${gen.branch}` : ''}`,
    )
    lines.push(
      snapshot.git.state === 'ok'
        ? `- changes: ${snapshot.git.changed.length}${snapshot.git.changedTruncated ? '+' : ''} path(s) · ahead ${snapshot.git.ahead} / behind ${snapshot.git.behind}`
        : `- changes: ${snapshot.git.note ?? 'git unavailable'}`,
    )
    if (marks.pins.length > 0) lines.push(`- pinned: ${marks.pins.join(', ')}`)
    if (marks.drops.length > 0) lines.push(`- dropped: ${marks.drops.join(', ')}`)
    if (snapshot.caps.omissions.length > 0)
      lines.push(`- omissions: ${snapshot.caps.omissions.join(' · ')}`)
    lines.push(
      '- inspect: `mercury://project/current` (modules · changes · knowledge · checks · context&q=<task> · impact&q=<path> · split&q=<a> || <b>)',
    )
    lines.push('- correct the working set: `/orient pin <path>` · `/orient drop <path>` · `/orient clear <path>`')
    return lines.join('\n')
  } catch {
    return null
  }
}

function markVerb(verb: 'pin' | 'drop' | 'clear', path: string): string {
  try {
    const { projectIntelEnabled } =
      require('../../services/projectIntel/contracts.js') as typeof import('../../services/projectIntel/contracts.js')
    if (!projectIntelEnabled()) {
      return 'Project intelligence is disabled (MERCURY_PROJECT_INTEL=0) — no working set to mark.'
    }
    const pins =
      require('../../services/projectIntel/pins.js') as typeof import('../../services/projectIntel/pins.js')
    const { processOwnerForLane } =
      require('../../services/run/resolveOwner.js') as typeof import('../../services/run/resolveOwner.js')
    const owner = processOwnerForLane(null)
    const workspace = getOriginalCwd()
    const result =
      verb === 'pin'
        ? pins.pinContextItem(owner, path, workspace)
        : verb === 'drop'
          ? pins.dropContextItem(owner, path, workspace)
          : pins.clearContextMark(owner, path, workspace)
    return result.note
  } catch (err) {
    return `mark failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

export const call: LocalCommandCall = async args => {
  const trimmed = args.trim()
  const [verb, ...rest] = trimmed.split(/\s+/)
  if (verb === 'pin' || verb === 'drop' || verb === 'clear') {
    return { type: 'text', value: markVerb(verb, rest.join(' ')) }
  }
  if (verb === 'pins') {
    try {
      const { getContextMarks } =
        require('../../services/projectIntel/pins.js') as typeof import('../../services/projectIntel/pins.js')
      const { processOwnerForLane } =
        require('../../services/run/resolveOwner.js') as typeof import('../../services/run/resolveOwner.js')
      const marks = getContextMarks(processOwnerForLane(null))
      return {
        type: 'text',
        value:
          marks.pins.length === 0 && marks.drops.length === 0
            ? 'No context marks this session.'
            : `pinned: ${marks.pins.join(', ') || '(none)'}\ndropped: ${marks.drops.join(', ') || '(none)'}`,
      }
    } catch {
      return { type: 'text', value: 'No context marks available.' }
    }
  }

  const map = buildRepoSurfaceMap(getOriginalCwd())
  const base = map ?? 'No surface to map here — the directory has no scannable files.'
  const intel = intelSection()
  return { type: 'text', value: intel ? `${base}\n${intel}` : base }
}
