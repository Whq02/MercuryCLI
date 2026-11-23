import type { AgentApp } from '@agentclientprotocol/sdk'
import {
  listReviewArtifactHeadsSource,
  readReviewArtifactState,
} from '../../../sessions/artifact-reviews/reviewStore.js'
import { healthOf, valueOr } from '../../../platform/substrate/sourceState.js'
import { getRunSnapshot } from '../../../engine/run/runCoordinator.js'
import { loadRunSidecar, runRevision } from '../../../engine/run/runSidecar.js'
import { processMainOwner } from '../../../engine/run-owner/resolveOwner.js'
import { isOwnerKey, type OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { resolveWorkbenchSnapshot } from '../../../screen/workbench/projection.js'
import { attentionWireFromSnapshot } from './attention.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export function mercuryRequests(app: AgentApp): AgentApp {
  return app
    .onRequest('_mercury/workbench', (v: unknown) => (v ?? {}), async () => {
      const snap = await resolveWorkbenchSnapshot()
      if (!snap) {
        return {
          threads: [],
          lanes: [],
          missions: [],
          artifactHeads: [],
          unavailable: 'the workbench projection is disabled',
        }
      }
      return {
        generation: snap.generation,
        nextAction: snap.nextAction,
        attention: attentionWireFromSnapshot(snap),
        threads: [snap.root, ...snap.threads].map(t => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          phase: t.phase,
          state: t.state,
          ...(t.model !== undefined && { model: t.model }),
          ...(t.worktreePath !== undefined && { worktreePath: t.worktreePath }),
          ...(t.blocker !== undefined && { blocker: t.blocker }),
        })),
        lanes: snap.lanes,
        missions: snap.missions,
        artifactHeads: snap.artifactHeads,
        sources: snap.sources,
      }
    })
    .onRequest('_mercury/artifacts', (v: unknown) => (v ?? {}), () => {
      const src = listReviewArtifactHeadsSource({ root: getCwd() })
      return {
        heads: valueOr(src, []).map(h => ({
          id: h.id,
          kind: h.kind,
          title: h.title,
          latestVersion: h.latestVersion,
          status: h.status,
          openComments: h.openComments,
        })),
        source: healthOf(src),
      }
    })
    .onRequest('_mercury/crew', (v: unknown) => (v ?? {}), async () => {
      const { crewDirectoryEnabled } = await import('../../../crew/crewmates/identity.js')
      if (!crewDirectoryEnabled()) {
        return {
          members: [],
          inbox: [],
          conversations: [],
          descriptors: [],
          unavailable: 'the crew directory is disabled (MERCURY_CREW_DIRECTORY=0)',
        }
      }
      const [{ resolveCrewSnapshot }, conversationsMod, { deriveInbox }, descriptorMod, graphMod, identityMod] =
        await Promise.all([
          import('../../../crew/crewmates/projection.js'),
          import('../../../crew/crewmates/conversations.js'),
          import('../../../crew/crewmates/inbox.js'),
          import('../../../crew/crewmates/descriptor.js'),
          import('../../../crew/crewmates/graph.js'),
          import('../../../platform/substrate/identity/identity.js'),
        ])
      const snap = await resolveCrewSnapshot()
      const operatorId = identityMod.operatorPrincipal().id
      const readErrors: Partial<Record<'conversations' | 'readCursors' | 'descriptors' | 'graph', string>> = {}
      const recordError = (key: 'conversations' | 'readCursors' | 'descriptors' | 'graph', error: unknown): void => {
        passedOver(error)
        readErrors[key] = error instanceof Error ? error.message : String(error)
      }
      const [conversations, cursors, descriptors, graph] = await Promise.all([
        conversationsMod.listConversations().catch(error => {
          recordError('conversations', error)
          return []
        }),
        conversationsMod.listReadCursors(operatorId).catch(error => {
          recordError('readCursors', error)
          return new Map<string, number>()
        }),
        descriptorMod.listSessionDescriptors().catch(error => {
          recordError('descriptors', error)
          return []
        }),
        graphMod.assembleSessionGraph().catch(error => {
          recordError('graph', error)
          return null
        }),
      ])
      const inbox = deriveInbox(conversations, id => (cursors as Map<string, number>).get(id) ?? 0)
      const labels = new Map((snap?.members ?? []).map(m => [m.agentId as string, m.label]))
      const { foldScopeDecisions } = await import('../../../sessions/artifacts/reviewContracts.js')
      const folioSrc = listReviewArtifactHeadsSource({ root: getCwd() })
      const folioHeads = valueOr(folioSrc, []).slice(0, 40).map(h => {
        const state = readReviewArtifactState(h.id)
        const fold = state ? foldScopeDecisions(state.scopeDecisions, state.latestVersion) : null
        return {
          id: h.id,
          kind: h.kind,
          title: h.title,
          latestVersion: h.latestVersion,
          status: h.status,
          openComments: h.openComments,
          ...(fold
            ? {
                scopeFold: {
                  accepted: fold.accepted,
                  revisionRequested: fold.revisionRequested,
                  suggestion: fold.suggestion,
                },
              }
            : {}),
        }
      })
      return {
        members: (snap?.members ?? []).map(m => ({
          agentId: m.agentId,
          label: m.label,
          displayName: m.displayName,
          presence: m.presence,
          ...(m.lifecycle !== undefined ? { lifecycle: m.lifecycle } : {}),
          ...(m.focus !== undefined ? { focus: m.focus } : {}),
          ...(m.worktreeRef !== undefined ? { worktreeRef: m.worktreeRef } : {}),
          openSessions: m.sessions.filter(s => s.endedAt === undefined).length,
        })),
        sources: snap?.sources ?? null,
        inbox: inbox.map(r => ({
          conversationId: r.conversationId,
          bucket: r.bucket,
          title: r.title,
          kind: r.kind,
          unreadCount: r.unreadCount,
          resumeSeq: r.resumeSeq,
          updatedAt: r.updatedAt,
        })),
        conversations: conversations.slice(-100).map(c => ({
          conversationId: c.conversationId,
          kind: c.kind,
          title: c.title,
          lastEventSeq: c.lastEventSeq,
          readCursor: (cursors as Map<string, number>).get(c.conversationId) ?? 0,
          updatedAt: c.updatedAt,
        })),
        descriptors: descriptors.map(d => ({
          agentId: d.agentId,
          sessionId: d.sessionId,
          ...(d.missionRef !== undefined ? { missionRef: d.missionRef } : {}),
          ...(d.worktreeRef !== undefined ? { worktreeRef: d.worktreeRef } : {}),
          revision: d.revision,
          title: descriptorMod.renderSessionTitle({
            agentLabel: labels.get(d.agentId as string) ?? (d.agentId as string),
            ...(d.missionRef !== undefined ? { missionLabel: d.missionRef } : {}),
            ...(d.worktreeRef !== undefined ? { worktreeLabel: d.worktreeRef } : {}),
          }),
        })),
        ...(graph !== null ? { graph } : {}),
        folioHeads,
        folioSource: healthOf(folioSrc),
        ...(Object.keys(readErrors).length > 0 ? { readErrors } : {}),
      }
    })
    .onRequest('_mercury/run', (v: unknown) => (v ?? {}), async ctx => {
      const asked = (ctx.params as { owner?: unknown } | null | undefined)?.owner
      let owner: OwnerKey
      if (asked === undefined) owner = processMainOwner()
      else if (isOwnerKey(asked)) owner = asked
      else return { error: 'malformed owner key' }
      let snap = getRunSnapshot(owner)
      if (snap === null) {
        try {
          const load = await loadRunSidecar(owner)
          if (load.state === 'loaded') snap = load.snapshot
          else if (load.state === 'unavailable') {
            return { unavailable: load.reason, retryable: load.retryable }
          }
        } catch (error) {
          return { unavailable: error instanceof Error ? error.message : String(error), retryable: false }
        }
      }
      const revision = runRevision(owner)
      if (snap === null) return { run: null, revision }
      return {
        revision,
        run: {
          runId: snap.runId,
          objective: snap.objective,
          lifecycle: snap.lifecycle,
          phase: snap.phase,
          nextAction: snap.nextAction,
          totalChangedPaths: snap.totalChangedPaths,
          verification: snap.verification.state,
          ...(snap.blocker
            ? { blocker: { description: snap.blocker.description, ownedBy: snap.blocker.ownedBy } }
            : {}),
          ...(snap.modelState ? { model: snap.modelState } : {}),
        },
      }
    })
    .onRequest(
      '_mercury/artifact',
      (v: unknown) => {
        const id = (v as { id?: unknown } | null)?.id
        if (typeof id !== 'string') throw new Error('params.id (ra-…) required')
        return { id }
      },
      ctx => {
        const state = readReviewArtifactState(ctx.params.id)
        if (!state) throw new Error(`no review artifact '${ctx.params.id}'`)
        const latest = state.versions[state.versions.length - 1]!
        const lines: string[] = [
          `# ${state.title}`,
          '',
          `${state.kind} v${state.latestVersion} · ${state.statuses[state.latestVersion] ?? 'draft'}`,
          '',
        ]
        if ('markdown' in latest.body) lines.push(latest.body.markdown, '')
        if (latest.body.kind === 'diff') {
          for (const f of latest.body.files) lines.push(`- ${f.path} (${f.hunks.length} hunks)`)
          lines.push('')
        }
        if (state.comments.length > 0) {
          lines.push('## Comments', '')
          for (const c of state.comments) {
            lines.push(`- [${c.state}] ${c.author}: ${c.body}`)
          }
        }
        return {
          id: state.id,
          kind: state.kind,
          status: state.statuses[state.latestVersion] ?? 'draft',
          latestVersion: state.latestVersion,
          comments: state.comments,
          rendered: lines.join('\n'),
        }
      },
    )
}
