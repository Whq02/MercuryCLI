
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
import { boundedTextView, type ResourceAdapter } from '../contracts.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { repositoryDenied, withheldLine } from '../referencePaths.js'

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
        const whole = gitTreeAtRef(root, treeRef, subPath)
        if ('state' in whole) return { state: 'unavailable', note: whole.note }
        const denied = await repositoryDenied((ctx.getAppState?.() as { toolPermissionContext?: ToolPermissionContext } | undefined)?.toolPermissionContext, root)
        const t = { ...whole, entries: whole.entries.filter(e => !denied(subPath ? `${subPath}/${e.name}` : e.name)) }
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
            text: [...t.entries.map(e => `${e.type}\t${e.name}${e.size !== null ? `\t${e.size}` : ''}`), ...withheldLine(whole.entries.length - t.entries.length, 'entry', 'entries')].join('\n'),
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
        const observed = gitConflicts(root, ctx.owner)
        if ('state' in observed) return { state: 'unavailable', note: observed.note }
        const denied = await repositoryDenied((ctx.getAppState?.() as { toolPermissionContext?: ToolPermissionContext } | undefined)?.toolPermissionContext, root)
        const all = observed.filter(c => !denied(c.path))
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
        const regionMatch = /^(gc-[a-f0-9]+)\/(gr-[a-f0-9]+)$/.exec(rest)
        if (regionMatch) {
          const file = all.find(c => c.id === regionMatch[1])
          const region = file?.regions?.find(r => r.id === regionMatch[2])
          if (!file || !region) return { state: 'absent', note: `region ${regionMatch[2]} is absent or stale` }
          const side = ref.selectors.child
          if (side && !['ours', 'theirs', 'base'].includes(side)) return { state: 'absent', note: `unknown region side '${side}'` }
          const part = side ? region[side as 'ours' | 'theirs' | 'base'] : { text: region.raw, line: region.startLine }
          if (!part) return { state: 'absent', note: `region ${region.id} has no base section` }
          const text = (part.text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line, i) => `${part.line + i}\t${line.replace(/\r?\n$/, '')}`).join('\n')
          const view = boundedTextView(text, ref.selectors, 80)
          return { state: 'ok', resource: { ref: ref.canonical, kind: 'git', title: `${file.path} ${region.id}${side ? ` ${side}` : ''}`, summary: `source lines ${part.line}-${part.line + Math.max(0, (part.text.match(/[^\n]*\n|[^\n]+$/g) ?? []).length - 1)}`, mutable: true, text: view.text, page: view.page } }
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
            structured: { ...hit, regions: undefined },
            ...boundedTextView((hit.regions ?? []).map(r => `${r.id} lines ${r.startLine}-${r.endLine} — mercury://git/conflict/${hit.id}/${r.id}`).join('\n'), ref.selectors, 80),
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
            ...(p.originalGroups ? boundedTextView([
              ...p.groups.map((g, i) => `${i + 1}. [group ${p.originalGroups![i]}] ${g.message.split('\n')[0]} — ${g.files.join(', ')}; depends on: ${g.dependsOn?.join(', ') || '(none)'}`),
              'applicability/tree evidence only; checks recorded, not run',
              ...(p.commits ?? []).map(c => `${c.sha} ${c.message.split('\n')[0]}`),
              ...(p.recovery ? [`first unapplied: ${p.recovery.firstUnapplied === null ? '(none)' : `group ${p.recovery.firstUnapplied}`}; blocked dependents: ${p.recovery.blockedDependents.join(', ') || '(none)'}; remaining work unchanged; prepare a new plan for that remainder`] : []),
            ].join('\n'), ref.selectors, 80) : {}),
            structured: {
              state: p.state,
              head: p.head,
              digest: p.digest,
              groups: p.groups,
              ...(p.originalGroups ? { originalGroups: p.originalGroups, verification: 'applicability/tree evidence only; checks recorded, not run' } : {}),
              ...(p.recovery ? { recovery: p.recovery } : {}),
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
