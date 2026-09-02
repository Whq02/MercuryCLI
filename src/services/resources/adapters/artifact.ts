// resources/adapters/artifact — the durable artifact store
// (mercury://artifact/<scope>/<id>, listing at mercury://artifact/<scope>)
// PLUS the review-artifact forms on the SAME kind (S2):
//   mercury://artifact/<ra-id>            → head (latest version + review state)
//   mercury://artifact/<ra-id>/v/<n>      → one immutable version
//   mercury://artifact/<ra-id>/comments   → the bounded comment thread
// Reads utils/artifacts/store.ts + reviewStore.ts — defensive by construction.

import { getArtifact, listArtifacts } from '../../../utils/artifacts/store.js'
import {
  isReviewArtifactId,
  readReviewArtifactState,
  reviewArtifactJournalExists,
} from '../../../utils/artifacts/reviewStore.js'
import type {
  ReviewArtifactState,
  ReviewArtifactVersion,
} from '../../../utils/artifacts/reviewContracts.js'
import { computeWorkingTreeDigest } from '../../../utils/verification/verificationState.js'
import {
  boundedTextView,
  formatRef,
  type ParsedRef,
  type ResourceContext,
  type ResourceResult,
  type ResourceAdapter,
} from '../contracts.js'

// ── review-artifact rendering ───────────────────────────────────────────────

function staleNote(version: ReviewArtifactVersion, fallbackCwd: string): string {
  const bound = version.workspace.treeDigest
  if (!bound) return ''
  try {
    // Staleness is judged against the tree the version was PRODUCED on
    // (workspace.roots[0]) — a lane artifact read from the main checkout
    // must not compare against the reader's unrelated tree.
    const root = version.workspace.roots[0] ?? fallbackCwd
    const current = computeWorkingTreeDigest(root)
    if (current && current !== bound) return ' · STALE (tree moved since this version)'
  } catch {
    /* digest unavailable — no staleness claim either way */
  }
  return ''
}

function versionLines(v: ReviewArtifactVersion, status: string, cwd: string): string[] {
  const lines: string[] = [
    `${v.title} — ${v.kind} v${v.version} · ${status}${staleNote(v, cwd)}`,
    `produced by session ${v.producer.sessionId}` +
      (v.producer.agentId ? ` · agent ${v.producer.agentId}` : '') +
      (v.producer.laneId ? ` · lane ${v.producer.laneId}` : '') +
      (v.producer.turn !== undefined ? ` · turn ${v.producer.turn}` : ''),
    `workspace ${v.workspace.roots.join(', ')}` +
      (v.workspace.treeDigest ? ` · tree ${v.workspace.treeDigest.slice(0, 12)}` : ''),
  ]
  switch (v.body.kind) {
    case 'plan':
    case 'report':
    case 'walkthrough':
      lines.push('', v.body.markdown)
      break
    case 'diff':
      lines.push('', ...v.body.files.map(f => `${f.path} (${f.hunks.length} hunks)`))
      break
    case 'visual':
      lines.push(
        '',
        ...v.body.captures.map(
          c => `capture ${c.ref}${c.title ? ` — ${c.title}` : ''} (${c.elements?.length ?? 0} elements)`,
        ),
      )
      break
    case 'journey':
      lines.push('', ...v.body.steps.map(s => `step ${s.id}: ${s.title}${s.result ? ` → ${s.result}` : ''}`))
      break
  }
  if (v.evidenceRefs.length > 0) lines.push('', `evidence: ${v.evidenceRefs.join(' · ')}`)
  return lines
}

function resolveReviewArtifact(ref: ParsedRef, ctx: ResourceContext): ResourceResult {
  const [id, ...rest] = ref.id.split('/')
  const state: ReviewArtifactState | null = readReviewArtifactState(id!)
  if (!state) {
    // absent ≠ damaged: a journal that EXISTS but cannot fold is
    // 'unavailable' with the damage named, never a silent "no artifact".
    if (reviewArtifactJournalExists(id!)) {
      return {
        state: 'unavailable',
        note: `the review artifact '${id}' journal exists but cannot be folded (damaged or unreadable) — nothing was deleted`,
      }
    }
    return { state: 'absent', note: `no review artifact '${id}'` }
  }
  const latest = state.versions[state.versions.length - 1]!
  const open = state.comments.filter(c => c.state === 'open')
  if (rest.length === 0) {
    const status = state.statuses[state.latestVersion] ?? 'draft'
    const full = [
      ...versionLines(latest, status, ctx.cwd),
      '',
      `versions: ${state.versions.map(v => `v${v.version} (${state.statuses[v.version] ?? 'draft'})`).join(' · ')}`,
      `comments: ${open.length} open · ${state.comments.filter(c => c.state === 'resolved').length} resolved · ${state.comments.filter(c => c.state === 'outdated').length} outdated`,
    ].join('\n')
    const view = boundedTextView(full, ref.selectors)
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'artifact',
        title: state.title,
        summary: `${state.kind} v${state.latestVersion} · ${status} · ${open.length} open comment(s)`,
        version: `v${state.latestVersion}`,
        mutable: true,
        text: view.text,
        page: view.page,
        structured: { head: true, id: state.id, kind: state.kind, status, latestVersion: state.latestVersion },
        children: [
          ...state.versions.map(v => ({
            ref: formatRef('artifact', `${state.id}/v/${v.version}`),
            title: `v${v.version}`,
            summary: `${state.statuses[v.version] ?? 'draft'} · ${new Date(v.createdAt).toISOString()}`,
          })),
          {
            ref: formatRef('artifact', `${state.id}/comments`),
            title: 'comments',
            summary: `${open.length} open of ${state.comments.length}`,
          },
        ],
      },
    }
  }
  if (rest[0] === 'v') {
    const n = Number(rest[1])
    const version = state.versions.find(v => v.version === n)
    if (!version) {
      return { state: 'absent', note: `no version ${rest[1]} of '${id}' (latest is v${state.latestVersion})` }
    }
    const status = state.statuses[version.version] ?? 'draft'
    const view = boundedTextView(versionLines(version, status, ctx.cwd).join('\n'), ref.selectors)
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'artifact',
        title: `${version.title} v${version.version}`,
        summary: `${version.kind} · ${status} — immutable`,
        version: `v${version.version}`,
        mutable: false,
        text: view.text,
        page: view.page,
        structured: version,
      },
    }
  }
  if (rest[0] === 'comments') {
    const lines = state.comments.map(
      c =>
        `[${c.state}] ${c.id} (${c.author}, v${c.version}, ${c.anchor.t}) ${c.body}` +
        (c.resolutionRef ? ` → ${c.resolutionRef}` : ''),
    )
    const view = boundedTextView(lines.join('\n') || '(no comments)', ref.selectors)
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'artifact',
        title: `${state.title} — comments`,
        summary: `${open.length} open of ${state.comments.length}`,
        mutable: true,
        text: view.text,
        page: view.page,
        structured: state.comments,
      },
    }
  }
  return {
    state: 'absent',
    note: `unknown review-artifact form '${rest.join('/')}' — forms: <id> · <id>/v/<n> · <id>/comments`,
  }
}

export const artifactAdapter: ResourceAdapter = {
  kind: 'artifact',
  describe:
    'durable run artifacts (mercury://artifact/<scope>/<id>) + versioned review artifacts (mercury://artifact/<ra-id>[/v/<n>|/comments])',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id === '') {
      return {
        state: 'absent',
        note: 'artifact refs need a scope: mercury://artifact/<scope> lists, mercury://artifact/<scope>/<id> reads (review artifacts: mercury://artifact/<ra-id>)',
      }
    }
    const headSegment = ref.id.split('/')[0]!
    if (isReviewArtifactId(headSegment)) {
      return resolveReviewArtifact(ref, ctx)
    }
    const slash = ref.id.indexOf('/')
    const scope = slash === -1 ? ref.id : ref.id.slice(0, slash)
    const id = slash === -1 ? '' : ref.id.slice(slash + 1)
    if (id === '') {
      const items = await listArtifacts(scope)
      return {
        state: 'ok',
        resource: {
          ref: ref.canonical,
          kind: 'artifact',
          title: `artifacts · ${scope}`,
          summary: `${items.length} artifact(s) in scope '${scope}'`,
          mutable: false,
          children: items.slice(0, 50).map(a => ({
            ref: formatRef('artifact', `${scope}/${a.id}`),
            title: a.name,
            summary: `${a.kind} · ${a.sizeBytes} bytes · ${a.createdAt}`,
          })),
        },
      }
    }
    const artifact = await getArtifact(scope, id)
    if (!artifact) {
      return {
        state: 'absent',
        note: `no artifact '${id}' in scope '${scope}' (it may have been pruned — the store self-prunes)`,
      }
    }
    const view = boundedTextView(artifact.content, ref.selectors)
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'artifact',
        title: artifact.meta.name,
        summary: `${artifact.meta.kind} · ${artifact.meta.sizeBytes} bytes · sha ${artifact.meta.sha256.slice(0, 12)}`,
        version: artifact.meta.sha256.slice(0, 12),
        mutable: false,
        text: view.text,
        page: view.page,
        structured: artifact.meta as unknown,
      },
    }
  },
}
