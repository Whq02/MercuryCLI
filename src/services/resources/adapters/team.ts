
import { readdirSync } from 'node:fs'
import * as path from 'node:path'
import { getCrewDir, readCrewFile } from '../../../utils/swarm/crewHelpers.js'
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
      const home = path.dirname(getCrewDir('probe'))
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
        .map(n => ({ name: n, file: readCrewFile(n) }))
        .filter(r => r.file !== null)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://team',
          kind: 'team',
          title: 'teams',
          summary: `${rows.length} crew(s) with a roster file`,
          mutable: true,
          children: rows.slice(0, 50).map(r => ({
            ref: formatRef('team', r.name),
            title: r.name,
            summary: `${r.file!.members.length} member(s)${r.file!.charter ? ' · chartered' : ''}`,
          })),
        },
      }
    }
    const crew = readCrewFile(ref.id)
    if (!crew) {
      return { state: 'absent', note: `no team '${ref.id}' (no roster file)` }
    }
    const charter = crew.charter as
      | { objective?: string; successCriteria?: string[] }
      | undefined
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'team',
        title: `team ${crew.name}`,
        summary: `${crew.members.length} member(s) · lead ${crew.leadAgentId}${charter ? ' · chartered' : ''}`,
        version: `m${crew.members.length}`,
        mutable: true,
        text: [
          `name: ${crew.name}`,
          ...(crew.description ? [`description: ${crew.description}`] : []),
          `lead: ${crew.leadAgentId}`,
          `created: ${new Date(crew.createdAt).toISOString()}`,
          ...(charter?.objective ? ['', `charter objective: ${charter.objective}`] : []),
          ...(charter?.successCriteria?.length
            ? ['success criteria:', ...charter.successCriteria.map(c => `  · ${c}`)]
            : []),
          '',
          `members (${crew.members.length}):`,
          ...crew.members.map(
            m =>
              `  ${(m as { name?: string }).name ?? '?'} — ${(m as { agentType?: string }).agentType ?? '?'}`,
          ),
        ].join('\n'),
        structured: {
          name: crew.name,
          members: crew.members.length,
          chartered: !!crew.charter,
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
