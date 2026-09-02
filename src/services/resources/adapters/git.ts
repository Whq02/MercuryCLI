// ============================================================================
//  resources/adapters/git — mercury://git/*. The local
//  work graph as first-class bounded resources:
//    mercury://git/status            — branch · files · digest
//    mercury://git/diff              — worktree diff (?child=staged for the
//                                       index; bounded hunks)
//    mercury://git/file/<path>      — one file's work-graph view (state ·
//                                       its hunks)
//    mercury://git/commit/<sha>     — commit meta + name-status
//    mercury://git/worktree         — worktree inventory
//    mercury://git/conflict/<id>    — one conflict (base/ours/theirs)
//    mercury://git/plan/<id>        — one commit plan (owner-scoped)
//  No unbounded history reads — a commit is addressed by sha, never "all".
// ============================================================================

import { gitGraphEnabled } from '../../gitGraph/contracts.js'
import {
  conflictId,
  gitCommitMeta,
  gitConflicts,
  gitDiff,
  gitStatus,
  gitWorktrees,
} from '../../gitGraph/observe.js'
import { getPlan, listPlans, planExpired } from '../../gitGraph/plan.js'
import { registerResourceAdapter } from '../registry.js'
import type { ResourceAdapter } from '../contracts.js'

export const gitAdapter: ResourceAdapter = {
  kind: 'git',
  describe: 'the local git work graph (status · diff · file/<path> · at/<ref>/<path> · tree/<ref>[/<path>] · compare/<a>...<b> · commit/<sha> · worktree · conflict/<id> · plan/<id>)',
  async resolve(ref, ctx) {
    if (!gitGraphEnabled()) {
      return { state: 'unavailable', note: 'the git work graph is disabled (MERCURY_GIT_GRAPH=0)' }
    }
    const [sub, ...restParts] = ref.id.split('/')
    const rest = restParts.join('/')
    const root = ctx.cwd

    switch (sub) {
      case 'status': {
        const s = gitStatus(root)
        if ('state' in s) return { state: 'unavailable', note: s.note }
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://git/status',
            kind: 'git',
            title: `${s.branch} @ ${s.head.slice(0, 8)}`,
            summary: s.clean
              ? 'clean'
              : `${s.files.length} changed file(s) · digest ${s.digest}`,
            version: s.digest,
            mutable: true,
            structured: {
              branch: s.branch,
              upstream: s.upstream,
              ahead: s.ahead,
              behind: s.behind,
              head: s.head,
              digest: s.digest,
              files: s.files.slice(0, 100),
            },
          },
        }
      }
      case 'diff': {
        const scope = ref.selectors.child === 'staged' ? 'staged' : 'worktree'
        const d = gitDiff(root, { scope })
        if ('state' in d) return { state: 'unavailable', note: d.note }
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/diff${scope === 'staged' ? '?child=staged' : ''}`,
            kind: 'git',
            title: `${scope} diff`,
            summary: `${d.files.length} file(s) · ${d.hunks.length} hunk(s)${d.truncated ? ' · TRUNCATED' : ''}`,
            mutable: true,
            structured: {
              scope,
              files: d.files,
              hunks: d.hunks.map(h => ({ id: h.id, file: h.file, header: h.header, additions: h.additions, deletions: h.deletions })),
              truncated: d.truncated,
            },
          },
        }
      }
      // Family 2: full payloads for the at-ref observation ops.
      // Slash-joined ids resolve the REF by progressively longer prefixes —
      // `at/origin/main/src/x.ts` addresses ref origin/main, never a
      // truncated 'origin' (splitRefPath).
      case 'at': {
        if (!rest.includes('/')) return { state: 'absent', note: 'git/at needs <ref>/<path>' }
        const { gitFileAtRef, splitRefPath } = await import('../../gitGraph/observe.js')
        const split = splitRefPath(root, rest)
        if (!split || !split.path) {
          return { state: 'unavailable', note: `no ref prefix of '${rest}' resolves to a commit here` }
        }
        const f = gitFileAtRef(root, split.ref, split.path)
        if ('state' in f) return { state: 'unavailable', note: f.note }
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/at/${split.ref}/${split.path}`,
            kind: 'git',
            title: `${split.path} @ ${split.ref}`,
            summary: `${f.bytes} byte(s)${f.truncated ? ' · TRUNCATED at 400KB' : ''}${f.binary ? ' · BINARY (text not faithful)' : ''}`,
            version: split.ref,
            mutable: false,
            text: f.binary ? `(binary blob — ${f.bytes} byte(s); content not rendered)` : f.text,
          },
        }
      }
      case 'tree': {
        const { gitTreeAtRef, splitRefPath } = await import('../../gitGraph/observe.js')
        const split = rest ? splitRefPath(root, rest, { allowEmptyPath: true }) : null
        if (!split) {
          return rest
            ? { state: 'unavailable', note: `no ref prefix of '${rest}' resolves to a commit here` }
            : { state: 'absent', note: 'git/tree needs <ref>[/<path>]' }
        }
        const treeRef = split.ref
        const subPath = split.path || undefined
        const t = gitTreeAtRef(root, treeRef, subPath)
        if ('state' in t) return { state: 'unavailable', note: t.note }
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/tree/${treeRef}${subPath ? `/${subPath}` : ''}`,
            kind: 'git',
            title: `${treeRef}${subPath ? `:${subPath}` : ''}`,
            summary: `${t.entries.length} entr${t.entries.length === 1 ? 'y' : 'ies'}${t.truncated ? ' · TRUNCATED' : ''}`,
            version: treeRef,
            mutable: false,
            structured: t,
            text: t.entries.map(e => `${e.type}\t${e.name}${e.size !== null ? `\t${e.size}` : ''}`).join('\n'),
          },
        }
      }
      case 'compare': {
        const dots = rest.indexOf('...')
        if (dots <= 0) return { state: 'absent', note: 'git/compare needs <base>...<head>' }
        const { gitCompare } = await import('../../gitGraph/observe.js')
        const c = gitCompare(root, rest.slice(0, dots), rest.slice(dots + 3))
        if ('state' in c) return { state: 'unavailable', note: c.note }
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/compare/${rest}`,
            kind: 'git',
            title: `${c.base}...${c.head}`,
            summary: `+${c.ahead} / -${c.behind} · merge-base ${c.mergeBase.slice(0, 8)} · ${c.files.length} file(s)`,
            mutable: false,
            structured: c,
          },
        }
      }
      case 'file': {
        if (!rest) return { state: 'absent', note: 'git/file needs a path' }
        const s = gitStatus(root)
        if ('state' in s) return { state: 'unavailable', note: s.note }
        const entry = s.files.find(f => f.path === rest)
        const d = gitDiff(root, { scope: 'worktree', paths: [rest] })
        const hunks = 'state' in d ? [] : d.hunks
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/file/${rest}`,
            kind: 'git',
            title: rest,
            summary: entry
              ? `${entry.kind}${entry.staged ? ` staged:${entry.staged}` : ''}${entry.unstaged ? ` unstaged:${entry.unstaged}` : ''} · ${hunks.length} hunk(s)`
              : 'unchanged in the work graph',
            mutable: true,
            structured: {
              state: entry ?? null,
              hunks: hunks.map(h => ({ id: h.id, header: h.header, lines: h.lines })),
            },
          },
        }
      }
      case 'commit': {
        if (!rest) return { state: 'absent', note: 'git/commit needs a sha' }
        const c = gitCommitMeta(root, rest)
        if ('state' in c) return { state: 'absent', note: c.note }
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/commit/${c.sha}`,
            kind: 'git',
            title: `${c.sha.slice(0, 8)} ${c.subject.slice(0, 60)}`,
            summary: `${c.author} · ${c.date} · ${c.files.length} file(s)`,
            version: c.sha,
            mutable: false,
            structured: c,
          },
        }
      }
      case 'worktree': {
        const w = gitWorktrees(root)
        if ('state' in w) return { state: 'unavailable', note: w.note }
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://git/worktree',
            kind: 'git',
            title: 'worktrees',
            summary: `${w.length} worktree(s)`,
            mutable: false,
            structured: { worktrees: w },
          },
        }
      }
      case 'conflict': {
        const all = gitConflicts(root)
        if ('state' in all) return { state: 'unavailable', note: all.note }
        if (!rest) {
          return {
            state: 'ok',
            resource: {
              ref: 'mercury://git/conflict',
              kind: 'git',
              title: 'conflicts',
              summary: `${all.length} unmerged path(s)`,
              mutable: true,
              children: all.map(c => ({
                ref: `mercury://git/conflict/${c.id}`,
                title: c.path,
                summary: `ours ${c.ours.length}L · theirs ${c.theirs.length}L`,
              })),
            },
          }
        }
        const hit = all.find(c => c.id === rest || conflictId(rest) === c.id || c.path === rest)
        if (!hit) return { state: 'absent', note: `no unmerged conflict '${rest}' here` }
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/conflict/${hit.id}`,
            kind: 'git',
            title: hit.path,
            summary: `base ${hit.base.length}L · ours ${hit.ours.length}L · theirs ${hit.theirs.length}L (bounded heads)`,
            mutable: true,
            structured: hit,
          },
        }
      }
      case 'plan': {
        if (!rest) return { state: 'absent', note: 'git/plan needs an id (gp-…)' }
        const p = getPlan(ctx.owner, rest)
        if (!p) {
          if (planExpired(ctx.owner, rest)) {
            return { state: 'expired', note: `plan '${rest}' fell off the bounded ring (16 kept) — re-prepare` }
          }
          return { state: 'absent', note: `no plan '${rest}' in this conversation` }
        }
        return {
          state: 'ok',
          resource: {
            ref: `mercury://git/plan/${p.id}`,
            kind: 'git',
            title: `${p.id} [${p.state}]`,
            summary: `${p.groups.length} group(s) · digest ${p.digest}${p.commits ? ` · ${p.commits.length} commit(s)` : ''}`,
            mutable: p.state === 'proposed',
            structured: {
              state: p.state,
              head: p.head,
              digest: p.digest,
              groups: p.groups,
              exclusions: p.exclusions,
              ambiguous: p.ambiguous,
              ...(p.note !== undefined && { note: p.note }),
              ...(p.commits !== undefined && {
                commits: p.commits.map(c => ({
                  sha: c.sha,
                  message: c.message,
                  files: c.files,
                  transactionRef: `mercury://transaction/${c.transactionId}`,
                  commitRef: `mercury://git/commit/${c.sha}`,
                })),
              }),
            },
          },
        }
      }
      default:
        return {
          state: 'absent',
          note: `unknown git sub-resource '${sub ?? ''}' — status · diff · file/<path> · commit/<sha> · worktree · conflict/<id> · plan/<id>`,
        }
    }
  },
  async list(ctx) {
    const s = gitStatus(ctx.cwd)
    const rows = [
      { ref: 'mercury://git/status', title: 'status', summary: 'state' in s ? s.note : `${s.branch} · ${s.files.length} changed` },
      { ref: 'mercury://git/diff', title: 'diff', summary: 'worktree diff (?child=staged for the index)' },
      { ref: 'mercury://git/worktree', title: 'worktree', summary: 'worktree inventory' },
    ]
    for (const p of listPlans(ctx.owner)) {
      rows.push({ ref: `mercury://git/plan/${p.id}`, title: p.id, summary: `[${p.state}] ${p.groups.length} group(s)` })
    }
    return rows
  },
}

registerResourceAdapter(gitAdapter)
