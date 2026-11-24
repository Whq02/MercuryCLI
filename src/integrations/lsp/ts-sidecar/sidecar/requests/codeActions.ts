import type * as TS from 'typescript'
import { RPC_INTERNAL_ERROR } from '../../../sidecarFraming.js'
import { type LspRange, type LspDiagnostic, type LspCodeAction, offsetAt, toUri, fromUri } from '../lsp.js'
import { fileTextChangesToWorkspaceEdit, FORMAT_OPTIONS } from '../convert.js'
import type { DocContext, RequireState } from '../needs.js'
import { passedOver } from '../../../../../platform/errors/passedOver.js'

export function codeActionRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, text } = docContext(params)
  const p = params as {
    range: LspRange
    context?: { diagnostics?: LspDiagnostic[]; only?: string[] }
  }
  const start = offsetAt(text, p.range.start)
  const end = offsetAt(text, p.range.end)
  const only = p.context?.only
  const wanted = (kind: string): boolean =>
    !only || only.some(o => kind === o || kind.startsWith(`${o}.`))
  const actions: LspCodeAction[] = []
  if (wanted('quickfix')) {
    let codes = (p.context?.diagnostics ?? [])
      .map(d => (typeof d.code === 'number' ? d.code : Number(d.code)))
      .filter(c => Number.isFinite(c))
    if (codes.length === 0) {
      const own = [
        ...project.service.getSyntacticDiagnostics(file),
        ...project.service.getSemanticDiagnostics(file),
      ]
      codes = own
        .filter(d => {
          const ds = d.start ?? 0
          const de = ds + (d.length ?? 0)
          return ds <= end && de >= start
        })
        .map(d => d.code)
    }
    const uniqueCodes = [...new Set(codes)]
    if (uniqueCodes.length > 0) {
      const fixes = project.service.getCodeFixesAtPosition(
        file,
        start,
        end,
        uniqueCodes,
        FORMAT_OPTIONS,
        {},
      )
      for (const fix of fixes) {
        actions.push({
          title: fix.description,
          kind: 'quickfix',
          edit: fileTextChangesToWorkspaceEdit(st, fix.changes),
        })
      }
    }
  }
  const wholeFile = { type: 'file' as const, fileName: file }
  const sourceActions: Array<{
    kind: string
    title: string
    compute: () => readonly TS.FileTextChanges[]
  }> = [
    {
      kind: 'source.organizeImports',
      title: 'Organize imports',
      compute: () =>
        project.service.organizeImports(
          { ...wholeFile, mode: st.ts.OrganizeImportsMode.All },
          FORMAT_OPTIONS,
          {},
        ),
    },
    {
      kind: 'source.removeUnusedImports',
      title: 'Remove unused imports',
      compute: () =>
        project.service.organizeImports(
          { ...wholeFile, mode: st.ts.OrganizeImportsMode.RemoveUnused },
          FORMAT_OPTIONS,
          {},
        ),
    },
    {
      kind: 'source.addMissingImports',
      title: 'Add all missing imports',
      compute: () =>
        project.service.getCombinedCodeFix(wholeFile, 'fixMissingImport', FORMAT_OPTIONS, {})
          .changes,
    },
    {
      kind: 'source.removeUnused',
      title: 'Remove all unused declarations',
      compute: () =>
        project.service.getCombinedCodeFix(
          wholeFile,
          'unusedIdentifier_delete',
          FORMAT_OPTIONS,
          {},
        ).changes,
    },
  ]
  for (const source of sourceActions) {
    if (only === undefined || !wanted(source.kind)) continue
    let changes: readonly TS.FileTextChanges[]
    try {
      changes = source.compute()
    } catch (error) {
      passedOver(error)
      continue
    }
    const edit = fileTextChangesToWorkspaceEdit(st, changes)
    if (Object.values(edit.changes).every(list => list.length === 0)) continue
    actions.push({ title: source.title, kind: source.kind, edit })
  }
  const wantsRefactor =
    wanted('refactor') || (only?.some(o => o.startsWith('refactor.')) ?? false)
  if (wantsRefactor) {
    const refactorOnly = only?.filter(o => o === 'refactor' || o.startsWith('refactor.'))
    const requestedKind =
      refactorOnly && refactorOnly.length === 1 && refactorOnly[0]!.startsWith('refactor.')
        ? refactorOnly[0]
        : undefined
    const refactors = project.service.getApplicableRefactors(
      file,
      start === end ? start : { pos: start, end },
      {},
      'invoked',
      requestedKind,
    )
    for (const refactor of refactors) {
      for (const action of refactor.actions) {
        if (action.notApplicableReason) continue
        const kind = action.kind ?? 'refactor'
        if (!wanted(kind)) continue
        actions.push({
          title:
            refactor.description === action.description
              ? action.description
              : `${refactor.description}: ${action.description}`,
          kind,
          data: {
            uri: toUri(file),
            refactorName: refactor.name,
            actionName: action.name,
            start,
            end,
          },
        })
      }
    }
  }
  return actions
}

export function codeActionResolveRequest(params: unknown, requireState: RequireState): unknown {
  const st = requireState()
  const action = params as LspCodeAction
  const data = action.data as
    | { uri?: string; refactorName?: string; actionName?: string; start?: number; end?: number }
    | undefined
  if (!data?.uri || !data.refactorName || !data.actionName) return action
  const file = st.normalize(fromUri(data.uri))
  const project = st.projectFor(file)
  const start = data.start ?? 0
  const end = data.end ?? start
  const info = project.service.getEditsForRefactor(
    file,
    FORMAT_OPTIONS,
    start === end ? start : { pos: start, end },
    data.refactorName,
    data.actionName,
    {},
  )
  if (!info) {
    throw Object.assign(new Error(`the refactor '${action.title}' produced no edit`), {
      rpcCode: RPC_INTERNAL_ERROR,
    })
  }
  if (info.edits.some(e => e.isNewFile)) {
    throw Object.assign(
      new Error(
        `the refactor '${action.title}' would create a file — a symbol move that creates its target goes through moveSymbol`,
      ),
      { rpcCode: RPC_INTERNAL_ERROR },
    )
  }
  return { ...action, edit: fileTextChangesToWorkspaceEdit(st, info.edits) }
}
