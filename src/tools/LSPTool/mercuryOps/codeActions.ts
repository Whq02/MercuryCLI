import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { type LspRangeLike, type WorkspaceEditLike } from '../../../services/lsp/workspaceEditApply.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { MercuryLspOpInput, MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, type LspWireDiagnostic, syncFileFromDisk } from './shared.js'
import { pullFileDiagnostics } from './pull.js'
import { prepareApply } from './prepare.js'
import { previewOf } from './preview.js'
import { applyPrepared } from './apply.js'

export type WireCodeAction = {
  title: string
  kind?: string
  edit?: WorkspaceEditLike
  command?: unknown
  data?: unknown
}

function actionShape(action: WireCodeAction): 'edit' | 'command-only' | 'lazy' {
  if (action.edit) return 'edit'
  if (action.command) return 'command-only'
  return 'lazy'
}

export function actionIdentity(action: WireCodeAction): string {
  const material = JSON.stringify([action.title, action.kind ?? '', actionShape(action)])
  return `ca-${createHash('sha256').update(material).digest('hex').slice(0, 8)}`
}

async function fetchCodeActions(
  env: OpEnv,
  range: LspRangeLike,
  contextDiagnostics: LspWireDiagnostic[],
  only?: string[],
): Promise<WireCodeAction[]> {
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  const response = await env.manager.sendRequest<Array<WireCodeAction | null> | null>(
    env.absolutePath,
    'textDocument/codeAction',
    {
      textDocument: { uri },
      range,
      context: {
        diagnostics: contextDiagnostics,
        ...(only !== undefined ? { only } : {}),
      },
    },
  )
  if (!Array.isArray(response)) return []
  return response.filter(
    (action): action is WireCodeAction =>
      action !== null && typeof action === 'object' && typeof action.title === 'string',
  )
}

async function resolveActionEdit(
  env: OpEnv,
  action: WireCodeAction,
): Promise<{ edit?: WorkspaceEditLike; resolveFailure?: string }> {
  if (action.edit) return { edit: action.edit }
  const claimant = env.manager.getServerForFile(env.absolutePath)
  const capabilities = claimant?.capabilities as ServerCapabilities | undefined
  const resolveProvider = Boolean(
    (capabilities?.codeActionProvider as { resolveProvider?: boolean } | undefined)
      ?.resolveProvider,
  )
  if (!resolveProvider) return {}
  try {
    const resolved = await env.manager.sendRequest<WireCodeAction | null>(
      env.absolutePath,
      'codeAction/resolve',
      action,
    )
    return resolved?.edit ? { edit: resolved.edit } : {}
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    logForDebugging(
      `lsp ops: codeAction/resolve failed for "${action.title}": ${failure}`,
    )
    return { resolveFailure: failure }
  }
}

export function inputRange(input: MercuryLspOpInput): LspRangeLike {
  const start = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const end = {
    line: (input.endLine ?? input.line ?? 1) - 1,
    character: (input.endCharacter ?? input.character ?? 1) - 1,
  }
  return { start, end }
}

export function lineRangesOverlap(a: LspRangeLike, b: LspRangeLike): boolean {
  return a.start.line <= b.end.line && a.end.line >= b.start.line
}

function formatActionRows(actions: WireCodeAction[]): string {
  return actions
    .map((action, index) => {
      const kind = action.kind ? ` (${action.kind})` : ''
      return `  [${index}] id:${actionIdentity(action)} ${action.title}${kind} — ${actionShape(action)}`
    })
    .join('\n')
}

export const CODE_ACTION_RERUN_HINT =
  'Re-run with apply: true and actionId to apply one (actionIndex is the positional selector from this listing).'

export async function opCodeActions(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const range = inputRange(input)
  const kind = input.kind?.trim() || undefined
  const only = kind !== undefined ? [kind] : undefined
  const where = `${display}:${input.line ?? 1}:${input.character ?? 1}${kind !== undefined ? ` for kind ${kind}` : ''}`

  let contextDiagnostics: LspWireDiagnostic[] = []
  try {
    const pulled = await pullFileDiagnostics(env.manager, env.absolutePath)
    if (pulled.kind === 'fresh' || pulled.kind === 'unchanged') {
      contextDiagnostics = pulled.items.filter(item => lineRangesOverlap(item.range, range))
    }
  } catch (error) {
    logForDebugging(
      `lsp ops: context diagnostics pull failed (continuing without): ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const actions = await fetchCodeActions(env, range, contextDiagnostics, only)
  if (actions.length === 0) {
    return {
      result: `No code actions offered at ${where}.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no actions offered',
      },
    }
  }

  const selecting = input.apply === true || input.actionId !== undefined || input.actionIndex !== undefined
  if (!selecting) {
    return {
      result: `${actions.length} code action(s) at ${where}:\n${formatActionRows(actions)}\n${CODE_ACTION_RERUN_HINT}`,
      resultCount: actions.length,
      fileCount: 1,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: `${actions.length} action(s) listed`,
        details: { preview: true },
      },
    }
  }

  let selected: WireCodeAction
  if (input.actionId === undefined && input.actionIndex === undefined && kind !== undefined && actions.length === 1) {
    selected = actions[0]!
  } else if (input.actionId !== undefined) {
    const matches = actions.filter(action => actionIdentity(action) === input.actionId)
    if (matches.length === 0) {
      return {
        result: `Apply refused: actionId ${input.actionId} is not in the current list — the offered actions changed since the listing. Current list:\n${formatActionRows(actions)}`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'actionId vanished — list changed',
        },
      }
    }
    if (matches.length > 1) {
      return {
        result: `Apply refused: actionId ${input.actionId} matches ${matches.length} identical actions — the selection is ambiguous. Narrow the range and re-list.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'ambiguous actionId',
        },
      }
    }
    selected = matches[0]!
    if (input.actionIndex !== undefined) {
      const byIndex = actions[input.actionIndex]
      if (!byIndex || actionIdentity(byIndex) !== input.actionId) {
        return {
          result: `Apply refused: actionId ${input.actionId} and actionIndex ${input.actionIndex} name different actions in the current list. Re-list and pass ONE selector.`,
          resultCount: 0,
          fileCount: 0,
          applied: false,
          effect: {
            outcome: 'failed',
            changedPaths: [],
            evidence: 'actionId/actionIndex disagree',
          },
        }
      }
    }
  } else {
    if (
      input.actionIndex === undefined ||
      input.actionIndex < 0 ||
      input.actionIndex >= actions.length
    ) {
      return {
        result: `apply: true requires actionId (preferred) or actionIndex in [0, ${actions.length - 1}]${kind !== undefined ? ` — or a kind that leaves exactly one action (${actions.length} match ${kind})` : ''}. Current list:\n${formatActionRows(actions)}`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'no valid selector',
        },
      }
    }
    selected = actions[input.actionIndex]!
  }

  const selectedResolution = await resolveActionEdit(env, selected)
  if (selectedResolution.resolveFailure !== undefined) {
    return {
      result: `Apply refused: resolving the edit for "${selected.title}" failed: ${selectedResolution.resolveFailure}. Re-list and retry.`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'edit resolution failed — nothing written',
      },
    }
  }
  if (!selectedResolution.edit) {
    return {
      result: `Apply refused: "${selected.title}" carries no workspace edit (a command-only action). Mercury refuses command execution via LSP — apply an edit-shaped action or make the change directly.`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'command-only action refused',
      },
    }
  }

  const selectedTitle = selected.title
  const selectedKind = selected.kind
  const requestEdit = async (): Promise<WorkspaceEditLike | null> => {
    const fresh = await fetchCodeActions(env, range, contextDiagnostics, only)
    const matches = fresh.filter(
      action => action.title === selectedTitle && (action.kind ?? '') === (selectedKind ?? ''),
    )
    if (matches.length > 1) {
      throw new Error(
        `the action "${selectedTitle}" appears ${matches.length} times in the refreshed list — ambiguous`,
      )
    }
    const match = matches[0]
    if (!match) return null
    return (await resolveActionEdit(env, match)).edit ?? null
  }
  const prepared = await prepareApply(env, requestEdit)
  if (!prepared.ok) {
    return {
      result: `${input.apply === true ? 'Apply' : 'Preview'} failed for "${selected.title}": ${prepared.reason}`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'code-action preparation failed — nothing written',
      },
    }
  }
  if (input.apply !== true) {
    const preview = previewOf(env, 'codeActions', prepared.files, prepared.snapshots, `and actionId: "${actionIdentity(selected)}" to apply it`)
    return { ...preview, result: `"${selected.title}" (${actionIdentity(selected)})\n${preview.result}` }
  }
  const applied = await applyPrepared(
    env,
    'codeActions',
    prepared.files,
    prepared.snapshots,
    `"${selected.title}" (${actionIdentity(selected)})\n`,
  )
  return applied.output
}
