// ============================================================================
//  resources/adapters/project — mercury://project/*.
//  Feature-owned kind, registered from the projectIntel slice:
//    mercury://project/current                    — the generation-keyed
//                                                   snapshot overview
//    mercury://project/current?child=modules      — bounded topology
//    mercury://project/current?child=changes      — changed paths (paged)
//    mercury://project/current?child=knowledge    — instructions/wiki/KB refs
//    mercury://project/current?child=checks       — launch/test discovery
//                                                   (on-demand, ASYNC — the
//                                                    base snapshot never pays)
//
//  This is the INSPECTION plane. The primary delivery path for project
//  intelligence is the context capsule riding existing tool results — the
//  measured failure mode of "a separate graph drawer the model must remember
//  to open" (LARGER, research F1.2) is exactly what this surface must not
//  become. Every projection carries generation + freshness provenance.
// ============================================================================

import { basename } from 'node:path'
import { discoverLaunchProfiles } from '../../ide/launchProfiles.js'
import { projectIntelEnabled } from '../../projectIntel/contracts.js'
import { assembleContextCapsule, renderCapsule } from '../../projectIntel/capsule.js'
import { projectImpact } from '../../projectIntel/impact.js'
import { suggestWorkSplit } from '../../projectIntel/split.js'
import { getProjectSnapshot } from '../../projectIntel/snapshot.js'
import { renderRepoSurfaceMap } from '../../../utils/cockpit/repoSurfaceMap.js'
import { registerResourceAdapter } from '../registry.js'
import type { ResourceAdapter, ResourceChild } from '../contracts.js'

const CHILDREN: ResourceChild[] = [
  {
    ref: 'mercury://project/current?child=modules',
    title: 'modules',
    summary: 'bounded topology: top-level dirs · languages · stack markers · scripts',
  },
  {
    ref: 'mercury://project/current?child=changes',
    title: 'changes',
    summary: 'current changed paths from the git owner (paged)',
  },
  {
    ref: 'mercury://project/current?child=knowledge',
    title: 'knowledge',
    summary: 'instructions, wiki index, local Projects knowledge presence',
  },
  {
    ref: 'mercury://project/current?child=checks',
    title: 'checks',
    summary: 'launch/test profile discovery (resolved on demand)',
  },
  {
    ref: 'mercury://project/current?child=context&q=<task>',
    title: 'context',
    summary: 'assemble + EXPLAIN the task-scoped working set (role · reason · freshness per item)',
  },
  {
    ref: 'mercury://project/current?child=impact&q=<path>',
    title: 'impact',
    summary: 'bounded impact projection: imports · importers · tests · change stats (established only)',
  },
  {
    ref: 'mercury://project/current?child=split&q=<taskA> || <taskB>',
    title: 'split',
    summary: 'advisory two-operator work split: per-stream files/tests + contested paths flagged',
  },
]

function generationLine(gen: {
  treeDigest: string | null
  headSha: string | null
  branch: string | null
  buildMs: number
}): string {
  const digest = gen.treeDigest ? gen.treeDigest.slice(0, 12) : 'no-digest'
  const head = gen.headSha ? gen.headSha.slice(0, 12) : 'no-head'
  return `generation ${digest} · HEAD ${head}${gen.branch ? ` (${gen.branch})` : ''} · base build ${gen.buildMs}ms`
}

export const projectAdapter: ResourceAdapter = {
  kind: 'project',
  describe: 'the generation-keyed project snapshot (current · modules · changes · knowledge · checks)',
  async resolve(ref, ctx) {
    if (!projectIntelEnabled()) {
      return { state: 'unavailable', note: 'project intelligence is disabled (MERCURY_PROJECT_INTEL=0)' }
    }
    if (ref.id !== 'current' && ref.id !== '') {
      return {
        state: 'absent',
        note: `unknown project resource '${ref.id}' — the current project is mercury://project/current`,
      }
    }
    const read = getProjectSnapshot(ctx.cwd)
    if (!read) {
      return { state: 'unavailable', note: 'project intelligence is disabled (MERCURY_PROJECT_INTEL=0)' }
    }
    const { snapshot, from } = read
    const child = ref.selectors.child

    if (!child) {
      const surfaceText = snapshot.surface ? renderRepoSurfaceMap(snapshot.surface) : '(empty tree — nothing to map)'
      const gitLine =
        snapshot.git.state === 'ok'
          ? `${snapshot.git.changed.length}${snapshot.caps.changedCap && snapshot.git.changedTruncated ? '+' : ''} changed path(s) · ahead ${snapshot.git.ahead} / behind ${snapshot.git.behind}`
          : `git: ${snapshot.git.note ?? 'unavailable'}`
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://project/current',
          kind: 'project',
          title: `project snapshot — ${basename(snapshot.workspace) || snapshot.workspace}`,
          summary: `${generationLine(snapshot.generation)} · ${from}`,
          version: snapshot.generation.treeDigest ?? undefined,
          mutable: true,
          children: CHILDREN,
          text: [
            surfaceText,
            '',
            `— git: ${gitLine}`,
            `— freshness: ${from} · ${generationLine(snapshot.generation)}`,
            ...(snapshot.caps.omissions.length
              ? [`— omissions: ${snapshot.caps.omissions.join(' · ')}`]
              : []),
          ].join('\n'),
          structured: snapshot,
        },
      }
    }

    if (child === 'modules') {
      const s = snapshot.surface
      if (!s) return { state: 'ok', resource: emptyChild('modules', 'empty tree — nothing to map', from) }
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://project/current?child=modules',
          kind: 'project',
          title: 'project modules',
          summary: `${s.topDirs.length} top-level dir(s) · ${s.topLangs.map(([l]) => l).join('/') || 'no languages detected'} · ${from}`,
          mutable: true,
          structured: {
            generation: snapshot.generation,
            topDirs: s.topDirs,
            languages: s.topLangs,
            markers: s.markerLabels,
            scripts: s.pkg?.scripts ?? [],
            bin: s.pkg?.bin ?? [],
            testDirs: s.testDirs,
            truncated: s.truncated,
          },
        },
      }
    }

    if (child === 'changes') {
      if (snapshot.git.state !== 'ok') {
        return { state: 'unavailable', note: snapshot.git.note ?? 'git unavailable' }
      }
      const cursor = ref.selectors.cursor ?? 0
      const limit = ref.selectors.limit ?? 50
      const page = snapshot.git.changed.slice(cursor, cursor + limit)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://project/current?child=changes',
          kind: 'project',
          title: 'changed paths',
          summary: `${snapshot.git.changed.length}${snapshot.git.changedTruncated ? '+' : ''} changed · ${from}`,
          mutable: true,
          text: page.map(c => `${c.kind === 'untracked' ? '??' : c.kind === 'unmerged' ? 'UU' : ' M'} ${c.path}`).join('\n'),
          structured: { generation: snapshot.generation, changed: page },
          page: {
            cursor,
            hasMore: cursor + limit < snapshot.git.changed.length,
            total: snapshot.git.changed.length,
          },
        },
      }
    }

    if (child === 'knowledge') {
      const k = snapshot.knowledge
      const i = snapshot.instructions
      const rows = [
        `CLAUDE.md: ${i.claudeMd ? 'present' : 'absent'}`,
        `AGENTS.md: ${i.agentsMd ? 'present' : 'absent'}`,
        `project config homes: ${i.configHomes.join(', ') || 'none'}`,
        `wiki index (docs/wiki/INDEX.md): ${k.wikiIndex ? 'present' : 'absent'}`,
      ]
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://project/current?child=knowledge',
          kind: 'project',
          title: 'project knowledge surfaces',
          summary: rows.slice(0, 2).join(' · '),
          mutable: true,
          text: rows.join('\n'),
          structured: { generation: snapshot.generation, instructions: i, knowledge: k },
        },
      }
    }

    if (child === 'checks') {
      // On-demand ASYNC discovery — the base snapshot never pays for this.
      const discovery = await discoverLaunchProfiles(ctx.cwd)
      const profiles = discovery.profiles.map(p => ({
        id: p.id,
        source: p.source,
        kind: p.kind,
        label: p.label,
      }))
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://project/current?child=checks',
          kind: 'project',
          title: 'project checks',
          summary: `${profiles.length} launch/test profile(s) · test dirs: ${snapshot.surface?.testDirs.join(', ') || 'none'}`,
          mutable: true,
          structured: {
            generation: snapshot.generation,
            profiles,
            skipped: discovery.skipped,
            testDirs: snapshot.surface?.testDirs ?? [],
            testFiles: snapshot.surface?.testFiles ?? 0,
          },
        },
      }
    }

    if (child === 'context') {
      const task = ref.selectors.q
      if (!task) {
        return {
          state: 'absent',
          note: 'the context child needs a task: mercury://project/current?child=context&q=<task text>',
        }
      }
      // EXPLAIN parity (audit): the projection must assemble with the
      // SAME session inputs the attachment producer uses — operator marks
      // and the active goal — or the explain surface disagrees item-for-item
      // with the capsule actually attached.
      let pins: string[] = []
      let drops: string[] = []
      let goal: string | null = null
      try {
        const { getContextMarks } =
          require('../../projectIntel/pins.js') as typeof import('../../projectIntel/pins.js')
        const { describeOwner, MAIN_LANE, makeOwnerKey, parseOwnerKey } =
          require('../../primitives/owner.js') as typeof import('../../primitives/owner.js')
        const identity = parseOwnerKey(ctx.owner)
        const mainOwner =
          describeOwner(ctx.owner).parent ?? makeOwnerKey({ ...identity, lane: MAIN_LANE })
        const marks = getContextMarks(mainOwner)
        pins = marks.pins
        drops = marks.drops
        const { getActiveMission } =
          require('../../../utils/hooks/missionHook.js') as typeof import('../../../utils/hooks/missionHook.js')
        goal = identity.sessionId ? (getActiveMission(identity.sessionId)?.condition ?? null) : null
      } catch {
        /* session inputs unavailable (headless resolver) — assemble bare */
      }
      const capsule = assembleContextCapsule({ workspace: ctx.cwd, task, goal, pins, drops })
      if (!capsule) {
        return { state: 'unavailable', note: 'project intelligence is disabled (MERCURY_PROJECT_INTEL=0)' }
      }
      return {
        state: 'ok',
        resource: {
          ref: `mercury://project/current?child=context&q=${encodeURIComponent(task.slice(0, 80))}`,
          kind: 'project',
          title: 'task-scoped working set',
          summary: `${capsule.items.length} item(s) · ${capsule.caps.omitted.count} omitted · assembled ${capsule.assembleMs}ms · ${from}`,
          version: capsule.digest,
          mutable: true,
          text: renderCapsule(capsule),
          structured: capsule,
        },
      }
    }

    if (child === 'impact') {
      const target = ref.selectors.q
      if (!target) {
        return { state: 'absent', note: 'the impact child needs a path: ?child=impact&q=<workspace-relative path>' }
      }
      const impact = projectImpact(ctx.cwd, target)
      if (!impact) {
        return { state: 'absent', note: `'${target}' is not a file in this workspace (or the slice is disabled)` }
      }
      const e = impact.established
      return {
        state: 'ok',
        resource: {
          ref: `mercury://project/current?child=impact&q=${encodeURIComponent(target)}`,
          kind: 'project',
          title: `impact — ${target}`,
          summary: `${e.importedBy.length} importer(s) · ${e.tests.length} test(s) · ${e.change ? `+${e.change.added}/−${e.change.deleted}` : 'clean'} · ${from}`,
          mutable: true,
          text: [
            `imports: ${e.imports.join(', ') || 'none detected'}`,
            `imported by: ${e.importedBy.join(', ') || 'none detected'}`,
            `tests: ${e.tests.join(', ') || 'none detected'}`,
            `working-tree change: ${e.change ? `+${e.change.added}/−${e.change.deleted}` : 'clean'}`,
            `diagnostics: ${e.diagnostics.note}${e.diagnostics.pendingCount ? ` (${e.diagnostics.pendingCount} pending)` : ''}`,
            ...(impact.inferences.length ? impact.inferences.map(i => `inference: ${i}`) : []),
            ...(impact.caps.omissions.length ? impact.caps.omissions.map(o => `omission: ${o}`) : []),
          ].join('\n'),
          structured: impact,
        },
      }
    }

    if (child === 'split') {
      const q = ref.selectors.q
      const tasks = (q ?? '').split('||').map(s => s.trim()).filter(Boolean)
      if (tasks.length < 2) {
        return { state: 'absent', note: 'the split child needs ≥2 tasks: ?child=split&q=<taskA> || <taskB>' }
      }
      const suggestion = suggestWorkSplit(ctx.cwd, tasks)
      if (!suggestion) {
        return { state: 'unavailable', note: 'project intelligence is disabled (MERCURY_PROJECT_INTEL=0)' }
      }
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://project/current?child=split',
          kind: 'project',
          title: 'advisory work split',
          summary: `${suggestion.perTask.length} streams · ${suggestion.contested.length} contested path(s) · ${from}`,
          mutable: true,
          text: [
            ...suggestion.perTask.map(
              (t, i) => `stream ${i + 1} (${t.task.slice(0, 60)}…): ${t.files.join(', ') || '(no exact evidence)'} · tests: ${t.tests.join(', ') || 'none'}`,
            ),
            ...(suggestion.contested.length
              ? suggestion.contested.map(c => `CONTESTED ${c.path} (streams ${c.tasks.map(n => n + 1).join('+')}): ${c.note}`)
              : ['no contested paths — the streams are disjoint on current evidence']),
            'advisory: provision actual zones through the collaboration parcel/zone verbs',
          ].join('\n'),
          structured: suggestion,
        },
      }
    }

    return {
      state: 'absent',
      note: `unknown project child '${child}' — children: modules · changes · knowledge · checks · context · impact · split`,
    }
  },
  async list() {
    return CHILDREN
  },
}

function emptyChild(title: string, note: string, from: string) {
  return {
    ref: `mercury://project/current?child=${title}`,
    kind: 'project',
    title,
    summary: `${note} · ${from}`,
    mutable: true,
  }
}

registerResourceAdapter(projectAdapter)
