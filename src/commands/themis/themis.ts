import type { LocalCommandCall } from '../../types/command.js'
import {
  activeMission,
  abandonMission,
  addCriterion,
  addPathToMission,
  completeMission,
  markWarningInspected,
  missionStatusLine,
  startMission,
} from '../../substrate/themis/mission.js'
import { themisLevel } from '../../substrate/themis/level.js'
import { getCwd } from '../../utils/cwd.js'

// `/themis` — the tracked-change-mission action grammar.
// Subcommands: (none)=status · start · crit · add · inspected · done · drop.
// Criteria amendable while active; the project-intel changed-path truth seeds
// suggestions at start; completion is evidence-gated and says EXACTLY what
// remains.

function suggestions(cwd: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
    const dirs = new Set<string>()
    for (const l of out.split('\n')) {
      const p = l.slice(3).trim()
      if (!p) continue
      // Separator-agnostic (the win32-seam ratchet): porcelain emits '/', but
      // split on both so a backslash path can never mint a bogus suggestion.
      const top = p.split(/[/\\]/).slice(0, 2).join('/')
      dirs.add(top)
    }
    return [...dirs].sort().slice(0, 6)
  } catch {
    return []
  }
}

export const call: LocalCommandCall = async (args, _context) => {
  const cwd = getCwd()
  const text = (v: string): { type: 'text'; value: string } => ({ type: 'text', value: v })
  const trimmed = String(args ?? '').trim()
  const [verb, ...rest] = trimmed.split(/\s+/)
  const restStr = trimmed.slice((verb ?? '').length).trim()

  if (!trimmed) {
    const m = activeMission(cwd)
    if (!m) {
      return text(
        [
          `No active mission (THEMIS level: ${themisLevel()}).`,
          'Track a substantial change: /themis start <title>',
          'Ordinary editing never needs a mission — this is optional run discipline for bounded multi-file work.',
        ].join('\n'),
      )
    }
    const open = m.warnings.filter(w => !w.resolution)
    return text(
      [
        missionStatusLine(cwd) ?? '',
        ...m.criteria.map(c => `  ${c.id}: ${c.text}${c.paths.length ? ` — paths: ${c.paths.join(', ')}` : ''}${c.checks.length ? ` — checks: ${c.checks.join(', ')}` : ''}`),
        m.expectedPaths.length ? `  also expected: ${m.expectedPaths.join(', ')}` : '',
        ...open.map(w => `  ▲ unexpected: ${w.path} (${w.tool}) — /themis add ${w.path} · /themis inspected ${w.path}`),
        '  verbs: crit <text> :: <paths> :: <checks> · add <path> · done · drop <why>',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  switch (verb) {
    case 'start': {
      if (!restStr) return text('usage: /themis start <title>')
      const r = startMission({ title: restStr }, cwd)
      if (!r.ok) return text(`cannot start: ${r.reason}`)
      const sugg = suggestions(cwd)
      return text(
        [
          `mission started: "${r.mission.title}" (${r.mission.id}) · level ${themisLevel()}`,
          'add criteria: /themis crit <text> :: <path-prefixes,comma-sep> :: <check-substrings,comma-sep>',
          sugg.length ? `changed-path suggestions from the working tree: ${sugg.join(', ')}` : '',
          'expected work stays quiet; an unexpected path warns ONCE (enforce refuses until added/inspected).',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }
    case 'crit': {
      const parts = restStr.split('::').map(s => s.trim())
      if (!parts[0]) return text('usage: /themis crit <text> :: <paths,comma-sep> :: <checks,comma-sep>')
      const r = addCriterion(
        {
          text: parts[0],
          paths: (parts[1] ?? '').split(',').map(s => s.trim()).filter(Boolean),
          checks: (parts[2] ?? '').split(',').map(s => s.trim()).filter(Boolean),
        },
        cwd,
      )
      return text(r.ok ? `criterion ${r.id} added` : `cannot add criterion: ${r.reason}`)
    }
    case 'add': {
      if (!restStr) return text('usage: /themis add <path>')
      const r = addPathToMission(restStr, cwd)
      return text(r.ok ? `${restStr} is now expected — its warning (if any) is resolved` : `cannot add: ${r.reason}`)
    }
    case 'inspected': {
      if (!restStr) return text('usage: /themis inspected <path>')
      return text(markWarningInspected(restStr, cwd) ? `${restStr} marked inspected` : 'no open warning for that path')
    }
    case 'done': {
      const v = completeMission(cwd)
      if (v.ok) {
        return text(
          [
            `mission complete · receipt @ .mercury/themis/themiss/`,
            ...v.receipt.criteria.map(c => `  ${c.id} "${c.text}" — by ${c.implementedBy.join(', ') || '(paths)'}${c.evidence.length ? ` · evidence ${c.evidence.join(' | ')}` : ''}`),
          ].join('\n'),
        )
      }
      return text(['not complete — remains:', ...v.remains.map(r => `  · ${r}`)].join('\n'))
    }
    case 'drop': {
      return text(abandonMission(restStr || 'operator dropped', cwd) ? 'mission abandoned (contract retained on disk)' : 'no active mission')
    }
    default:
      return text('verbs: (none)=status · start <title> · crit <text> :: <paths> :: <checks> · add <path> · inspected <path> · done · drop <why>')
  }
}
