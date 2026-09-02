// resources/adapters/team — chartered teams + their members
// (mercury://team/<name>). Daemon-hosted crews are teams too, so a crew
// lane is addressable through this kind.

import { readdirSync } from 'node:fs'
import * as path from 'node:path'
import { getTeamDir, readTeamFile } from '../../../utils/swarm/teamHelpers.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceResult,
} from '../contracts.js'

export const teamAdapter: ResourceAdapter = {
  kind: 'team',
  describe: 'chartered teams, members, charters — incl. daemon crews (mercury://team/<name>)',
  async resolve(ref: ParsedRef): Promise<ResourceResult> {
    if (ref.id === '') {
      // Listing: the teams home directory (sibling of any team's dir).
      const home = path.dirname(getTeamDir('probe'))
      let names: string[] = []
      try {
        names = readdirSync(home, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .sort()
      } catch {
        return { state: 'ok', resource: emptyListing() }
      }
      const rows = names
        .map(n => ({ name: n, file: readTeamFile(n) }))
        .filter(r => r.file !== null)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://team',
          kind: 'team',
          title: 'teams',
          summary: `${rows.length} team(s) with a roster file`,
          mutable: true,
          children: rows.slice(0, 50).map(r => ({
            ref: formatRef('team', r.name),
            title: r.name,
            summary: `${r.file!.members.length} member(s)${r.file!.charter ? ' · chartered' : ''}`,
          })),
        },
      }
    }
    const team = readTeamFile(ref.id)
    if (!team) {
      return { state: 'absent', note: `no team '${ref.id}' (no roster file)` }
    }
    const charter = team.charter as
      | { objective?: string; successCriteria?: string[] }
      | undefined
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'team',
        title: `team ${team.name}`,
        summary: `${team.members.length} member(s) · lead ${team.leadAgentId}${charter ? ' · chartered' : ''}`,
        version: `m${team.members.length}`,
        mutable: true,
        text: [
          `name: ${team.name}`,
          ...(team.description ? [`description: ${team.description}`] : []),
          `lead: ${team.leadAgentId}`,
          `created: ${new Date(team.createdAt).toISOString()}`,
          ...(charter?.objective ? ['', `charter objective: ${charter.objective}`] : []),
          ...(charter?.successCriteria?.length
            ? ['success criteria:', ...charter.successCriteria.map(c => `  · ${c}`)]
            : []),
          '',
          `members (${team.members.length}):`,
          ...team.members.map(
            m =>
              `  ${(m as { name?: string }).name ?? '?'} — ${(m as { agentType?: string }).agentType ?? '?'}`,
          ),
        ].join('\n'),
        structured: {
          name: team.name,
          members: team.members.length,
          chartered: !!team.charter,
        },
      },
    }
  },
}

function emptyListing() {
  return {
    ref: 'mercury://team',
    kind: 'team',
    title: 'teams',
    summary: 'no teams home yet (none created)',
    mutable: true,
    children: [],
  }
}
