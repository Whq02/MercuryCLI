
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { readLocationSourceLines, type Locationish } from './formatters.js'
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { z } from 'zod/v4'
import { LSP_ONE_LINE_MAX } from '../../services/lsp/failureWords.js'
import { isLspStartFailure, type LSPServerInstance } from '../../services/lsp/LSPServerInstance.js'
import { formatEditPreview, normalizeWorkspaceEdit, type LspRangeLike, type LspTextEditLike, type NormalizedFileEdits, type WorkspaceEditLike } from '../../services/lsp/workspaceEditApply.js'
import { renameWithWin32Retry } from '../../substrate/durablePublish.js'
import { logForDebugging } from '../../utils/debug.js'
import { expandPath } from '../../utils/path.js'
import { collapseAndClip } from '../../utils/stringUtils.js'
import {
  checkWritePermissionForTool,
  pathInAllowedWorkingPath,
} from '../../utils/permissions/filesystem.js'
import { postureBypassesAsks } from '../../utils/permissions/decision/engine.js'
import type { MercuryLspOpInput, MercuryLspOpOutput, OpEnv } from './mercuryOps/types.js'
import { PREPARE_ROUNDS, WORKSPACE_DIAG_FILE_CAP, PATH_RENAME_FILE_CAP, IGNORED_WALK_DIRS, displayPathFor, uriToFilePath, isMethodNotFoundError, type LspWireDiagnostic, sortDiagnostics, formatDiagnosticLine, countBySeverity, syncFileFromDisk } from './mercuryOps/shared.js'
import { type PullDiagnosticsOutcome, remedyForUnclaimedExtension, pullFileDiagnostics, unavailableWords } from './mercuryOps/pull.js'
import { awaitDiagnosticStabilization } from './mercuryOps/afterWrite.js'
import { opServerStatus } from './mercuryOps/serverStatus.js'
import { prepareApply } from './mercuryOps/prepare.js'
import { changeViewOf, planFiles, planTokenOf, editRowsFor, previewOf } from './mercuryOps/preview.js'
import { applyPrepared } from './mercuryOps/apply.js'
export type { MercuryLspOpInput, MercuryLspOpOutput } from './mercuryOps/types.js'
export { clearDiagnosticsBaselines } from './mercuryOps/pull.js'
export { syncServersAfterWrite, awaitDiagnosticStabilization } from './mercuryOps/afterWrite.js'
export { NO_LSP_SERVERS_CONFIGURED, serverStatusLines } from './mercuryOps/serverStatus.js'

type WireCodeAction = {
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

async function opDiagnostics(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  let pulled: PullDiagnosticsOutcome
  try {
    await syncFileFromDisk(env.manager, env.absolutePath)
    pulled = await pullFileDiagnostics(env.manager, env.absolutePath)
  } catch (err) {
    const primary = env.manager.getServerForFile(env.absolutePath)
    if (isLspStartFailure(err) && primary !== undefined) {
      pulled = { kind: 'unavailable', failed: [{ server: primary, stage: 'start', cause: err.lspCause, startFailure: err }] }
    } else {
      throw err
    }
  }
  if (pulled.kind === 'no-claimant') {
    const extension = extname(env.absolutePath).toLowerCase()
    return {
      result:
        `${display} was not checked: no language server claims '${extension}' files in this session — ` +
        remedyForUnclaimedExtension(extension, env.cwd),
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: `no language server claims '${extension}'`,
      },
    }
  }
  if (pulled.kind === 'unavailable') {
    const words = unavailableWords(pulled.failed, env.absolutePath, env.cwd)
    return {
      result: `${display} was not checked: ${words.what}.${words.remedy ? ` What helps: ${words.remedy}.` : ''}`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: words.what,
        details: { serverFailures: words.servers },
      },
    }
  }
  if (pulled.kind === 'unsupported') {
    return {
      result:
        `${display} was not checked: ${pulled.pushOnly.join(', ')} publish${pulled.pushOnly.length === 1 ? 'es' : ''} diagnostics instead of answering requests, and no report for this file arrived within 5 s. ` +
        `Their reports reach the conversation on their own when they publish.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'indeterminate',
        changedPaths: [],
        evidence: 'no pull capability and no published report',
      },
    }
  }
  if (pulled.kind === 'protocol-violation') {
    return {
      result: `Diagnostics are indeterminate for ${display}: ${pulled.detail} — nothing can be claimed about this file.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'indeterminate',
        changedPaths: [],
        evidence: 'diagnostic protocol violation — indeterminate',
      },
    }
  }
  const sourceNote = [
    ...(pulled.pulledFrom && pulled.pulledFrom.length > 0 ? [`pulled: ${pulled.pulledFrom.join(', ')}`] : []),
    ...(pulled.pushed && pulled.pushed.length > 0 ? [`published: ${pulled.pushed.join(', ')}`] : []),
    ...(pulled.failed && pulled.failed.length > 0 ? [`not answered: ${unavailableWords(pulled.failed, env.absolutePath, env.cwd).what}`] : []),
  ].join(' · ')
  const provenance =
    (pulled.kind === 'fresh'
      ? `[fresh report (document version ${pulled.docVersion ?? 'unknown'})`
      : `[unchanged — server re-affirmed the last report (document version ${pulled.docVersion ?? 'unknown'})`) +
    (sourceNote ? ` — ${sourceNote}]` : ']')
  if (pulled.items.length === 0) {
    return {
      result: `No diagnostics — ${display} is clean. ${provenance}`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: `clean ${provenance}`,
      },
    }
  }
  const sorted = sortDiagnostics(pulled.items)
  const { errors, warnings } = countBySeverity(sorted)
  const lines = sorted.map(item => `  ${formatDiagnosticLine(display, item)}`).join('\n')
  return {
    result: `${sorted.length} diagnostics (${errors} errors, ${warnings} warnings) ${provenance}:\n${lines}`,
    resultCount: sorted.length,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `${errors} error(s), ${warnings} warning(s) ${provenance}`,
    },
  }
}

async function opSwitchSourceHeader(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  const claimant = env.manager.getServerForFile(env.absolutePath)
  if (!claimant) {
    const extension = extname(env.absolutePath) || basename(env.absolutePath)
    return {
      result:
        `No language server claims ${extension} files, so switchSourceHeader is unavailable for ${display}. ` +
        `The C/C++ lane (mercury-clangd) provides it when a workspace clangd is present and MERCURY_LSP_CPP is not disabled.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'no claimant for the C/C++ lane',
      },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  let response: string | null | undefined
  try {
    response = await env.manager.sendRequest<string | null>(
      env.absolutePath,
      'textDocument/switchSourceHeader',
      { uri },
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return {
        result: `The ${claimant.name} server does not support switchSourceHeader (the request is a clangd extension).`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'server does not support switchSourceHeader',
        },
      }
    }
    throw error
  }
  if (!response) {
    return {
      result:
        `No source/header counterpart found for ${display}. ` +
        `A compile_commands.json in the workspace usually lets clangd resolve counterparts across directories.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no counterpart (a real answer)',
      },
    }
  }
  return {
    result: `Counterpart: ${displayPathFor(env.cwd, response)}`,
    resultCount: 1,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: 'counterpart resolved',
    },
  }
}

async function opRename(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const newName = input.newName ?? ''
  if (newName === '' || /\s/.test(newName)) {
    return {
      result: `Rename failed: newName must be a non-empty identifier without whitespace (got ${JSON.stringify(newName)}).`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'invalid newName',
      },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  const position = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const requestEdit = (): Promise<WorkspaceEditLike | null | undefined> =>
    env.manager.sendRequest<WorkspaceEditLike | null>(env.absolutePath, 'textDocument/rename', {
      textDocument: { uri },
      position,
      newName,
    })
  const prepared = await prepareApply(env, requestEdit)
  if (!prepared.ok) {
    return {
      result: `Rename failed: ${prepared.reason}`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'rename preparation failed — nothing written',
      },
    }
  }
  if (input.apply !== true) {
    return previewOf(env, 'rename', prepared.files, prepared.snapshots, 'to write the rename')
  }
  const applied = await applyPrepared(env, 'rename', prepared.files, prepared.snapshots)
  return applied.output
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

function inputRange(input: MercuryLspOpInput): LspRangeLike {
  const start = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const end = {
    line: (input.endLine ?? input.line ?? 1) - 1,
    character: (input.endCharacter ?? input.character ?? 1) - 1,
  }
  return { start, end }
}

function lineRangesOverlap(a: LspRangeLike, b: LspRangeLike): boolean {
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

const CODE_ACTION_RERUN_HINT =
  'Re-run with apply: true and actionId to apply one (actionIndex is the positional selector from this listing).'

async function opCodeActions(env: OpEnv): Promise<MercuryLspOpOutput> {
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

async function opTypeDefinition(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  type Location = { uri?: string; targetUri?: string; range?: LspRangeLike; targetRange?: LspRangeLike; targetSelectionRange?: LspRangeLike }
  let response: Location | Location[] | null | undefined
  try {
    response = await env.manager.sendRequest<Location | Location[] | null>(
      env.absolutePath,
      'textDocument/typeDefinition',
      {
        textDocument: { uri },
        position: { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 },
      },
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return {
        result: `The language server for ${display} does not support typeDefinition.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'typeDefinition unsupported',
        },
      }
    }
    throw error
  }
  const list: Location[] =
    response === null || response === undefined
      ? []
      : Array.isArray(response)
        ? response
        : [response]
  if (list.length === 0) {
    return {
      result: `No type definition found at ${display}:${input.line ?? 1}:${input.character ?? 1}.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no type definition (a real answer)',
      },
    }
  }
  const rows: string[] = []
  const displays = new Set<string>()
  const sourceLines = await readLocationSourceLines(list as Locationish[], env.tool, env.context)
  let total = 0
  for (const location of list) {
    const locationUri = location.targetUri ?? location.uri
    if (locationUri === undefined) continue
    const range = location.targetSelectionRange ?? location.targetRange ?? location.range
    const locationDisplay = displayPathFor(env.cwd, locationUri)
    displays.add(locationDisplay)
    const line = (range?.start.line ?? 0) + 1
    const character = (range?.start.character ?? 0) + 1
    total++
    if (total <= 50) {
      rows.push(`  ${locationDisplay}:${line}:${character}`)
      const source = sourceLines.get(location as Locationish)
      if (source) rows.push(`    ${source}`)
    }
  }
  if (total > 50) rows.push(`${total - 50} more type definitions.`)
  return {
    result: `${total} type definition(s):\n${rows.join('\n')}`,
    resultCount: total,
    fileCount: displays.size,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `${total} location(s)`,
    },
  }
}

async function opWorkspaceDiagnostics(env: OpEnv): Promise<MercuryLspOpOutput> {
  const paths = env.input.paths ?? []
  const included: string[] = []
  const skipped: string[] = []
  const unclaimed: string[] = []
  const unreadable: string[] = []
  let truncated = false

  const includeFile = (abs: string): void => {
    if (included.length >= WORKSPACE_DIAG_FILE_CAP) {
      truncated = true
      return
    }
    if (env.manager.getServerForFile(abs)) included.push(abs)
    else {
      skipped.push(abs)
      unclaimed.push(abs)
    }
  }

  const walkDirectory = async (dir: string): Promise<void> => {
    if (truncated) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      skipped.push(dir)
      unreadable.push(dir)
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const files: string[] = []
    const subdirectories: string[] = []
    for (const entry of entries) {
      const child = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_WALK_DIRS.has(entry.name)) continue
        subdirectories.push(child)
      } else if (entry.isFile()) {
        files.push(child)
      }
    }
    for (const file of files) {
      if (truncated) return
      includeFile(file)
    }
    for (const subdirectory of subdirectories) {
      if (truncated) return
      await walkDirectory(subdirectory)
    }
  }

  for (const raw of paths) {
    if (truncated) break
    const abs = resolve(env.cwd, raw)
    let stats
    try {
      stats = await stat(abs)
    } catch {
      skipped.push(abs)
      unreadable.push(abs)
      continue
    }
    if (stats.isDirectory()) await walkDirectory(abs)
    else includeFile(abs)
  }

  const listed = (items: string[]): string => {
    const shown = items.slice(0, 5).map(p => displayPathFor(env.cwd, p))
    return `${shown.join(', ')}${items.length > 5 ? ` (+${items.length - 5} more)` : ''}`
  }

  if (included.length === 0) {
    const reasons: string[] = []
    if (unclaimed.length > 0) {
      const byExtension = new Map<string, string[]>()
      for (const p of unclaimed) {
        const ext = extname(p).toLowerCase() || basename(p)
        byExtension.set(ext, [...(byExtension.get(ext) ?? []), p])
      }
      for (const [ext, files] of byExtension) {
        reasons.push(`no language server claims '${ext}' files in this session (${listed(files)}) — ${remedyForUnclaimedExtension(ext, env.cwd)}`)
      }
    }
    if (unreadable.length > 0) reasons.push(`${listed(unreadable)}: not found or unreadable`)
    if (reasons.length === 0) reasons.push('no paths were given')
    return {
      result: `Nothing was checked: ${reasons.join('; ')}`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: collapseAndClip(reasons[0] ?? 'no claimed files', LSP_ONE_LINE_MAX),
        details: { skipped: skipped.length },
      },
    }
  }

  let errors = 0
  let warnings = 0
  let totalDiagnostics = 0
  let filesWithFindings = 0
  let answered = 0
  let indeterminate = 0
  const failedServers = new Map<string, string>()
  const remedies = new Set<string>()
  const lines: string[] = []
  const notChecked = (display: string, words: { what: string; remedy: string; servers: Array<{ server: string; cause: string }> }): void => {
    lines.push(`  not checked: ${display} — ${words.what}`)
    for (const failure of words.servers) failedServers.set(failure.server, failure.cause)
    if (words.remedy !== '') remedies.add(words.remedy)
  }
  for (const abs of included) {
    const display = displayPathFor(env.cwd, abs)
    try {
      await syncFileFromDisk(env.manager, abs)
      const pulled = await pullFileDiagnostics(env.manager, abs)
      if (pulled.kind === 'fresh' || pulled.kind === 'unchanged') {
        answered++
        if (pulled.items.length > 0) {
          filesWithFindings++
          const counts = countBySeverity(pulled.items)
          errors += counts.errors
          warnings += counts.warnings
          totalDiagnostics += pulled.items.length
          for (const item of sortDiagnostics(pulled.items)) {
            lines.push(`  ${formatDiagnosticLine(display, item)}`)
          }
        }
        if (pulled.failed && pulled.failed.length > 0) {
          const words = unavailableWords(pulled.failed, abs, env.cwd)
          lines.push(`  partly checked: ${display} — ${words.what}`)
          for (const failure of words.servers) failedServers.set(failure.server, failure.cause)
        }
      } else if (pulled.kind === 'unavailable') {
        notChecked(display, unavailableWords(pulled.failed, abs, env.cwd))
      } else if (pulled.kind === 'unsupported') {
        indeterminate++
        lines.push(`  indeterminate: ${display} — ${pulled.pushOnly.join(', ')} publish${pulled.pushOnly.length === 1 ? 'es' : ''} diagnostics instead of answering requests, and no report arrived within 5 s`)
      } else if (pulled.kind === 'no-claimant') {
        indeterminate++
        lines.push(`  indeterminate: ${display} — no language server claims this extension (nothing to pull)`)
      } else {
        indeterminate++
        lines.push(`  indeterminate: ${display} — ${pulled.detail}`)
      }
    } catch (error) {
      const primary = env.manager.getServerForFile(abs)
      if (isLspStartFailure(error) && primary !== undefined) {
        notChecked(display, unavailableWords([{ server: primary, stage: 'start', cause: error.lspCause, startFailure: error }], abs, env.cwd))
      } else {
        notChecked(display, { what: error instanceof Error ? error.message : String(error), remedy: '', servers: [] })
      }
    }
  }

  const failedFiles = included.length - answered - indeterminate
  const capNote = truncated
    ? ` (CAPPED at ${WORKSPACE_DIAG_FILE_CAP} — the set was larger; narrow the paths)`
    : ''
  const skippedNote = skipped.length > 0 ? `, ${skipped.length} skipped (unclaimed/unreadable)` : ''
  const indeterminateNote = indeterminate > 0 ? `, ${indeterminate} indeterminate` : ''
  const notCheckedNote = failedFiles > 0 ? `, ${failedFiles} not checked` : ''
  let summary = `${answered} of ${included.length} file(s) checked${capNote}${skippedNote} — ${errors} error(s), ${warnings} warning(s) in ${filesWithFindings} file(s)${indeterminateNote}${notCheckedNote}`
  if (lines.length === 0) summary += ' — all clean.'
  const helps = remedies.size > 0 ? `\nWhat helps: ${[...remedies].join('; ')}.` : ''
  const noneAnswered = answered === 0 && failedFiles > 0
  const complete = answered === included.length
  return {
    result: (lines.length > 0 ? `${summary}\n${lines.join('\n')}` : summary) + helps,
    resultCount: totalDiagnostics,
    fileCount: included.length,
    effect: {
      outcome: noneAnswered ? 'failed' : complete ? 'succeeded' : 'indeterminate',
      changedPaths: [],
      evidence: noneAnswered ? (lines[0] ?? 'no file answered').trim() : `${errors} error(s), ${warnings} warning(s) across ${answered} of ${included.length} file(s)`,
      details: { truncated, skipped: skipped.length, indeterminate, notChecked: failedFiles, ...(failedServers.size > 0 ? { serverFailures: [...failedServers].map(([server, cause]) => ({ server, cause })) } : {}) },
    },
  }
}

function lspRangesIntersect(a: LspRangeLike, b: LspRangeLike): boolean {
  const cmp = (x: { line: number; character: number }, y: { line: number; character: number }): number =>
    x.line - y.line || x.character - y.character
  return cmp(a.start, b.end) < 0 && cmp(b.start, a.end) < 0
}

async function pathRenameClaimants(
  env: OpEnv,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): Promise<LSPServerInstance[]> {
  const seen = new Set<string>()
  const out: LSPServerInstance[] = []
  const addAll = (servers: LSPServerInstance[]): void => {
    for (const s of servers) {
      if (!seen.has(s.name)) {
        seen.add(s.name)
        out.push(s)
      }
    }
  }
  if (!isDirectory) {
    addAll(env.manager.getServersForFile(oldPath))
    addAll(env.manager.getServersForFile(newPath))
    return out
  }
  const FILE_SCAN_CAP = 2_000
  let scanned = 0
  const extensions = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    if (scanned >= FILE_SCAN_CAP) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (scanned >= FILE_SCAN_CAP) return
      if (entry.isDirectory()) {
        if (IGNORED_WALK_DIRS.has(entry.name)) continue
        await walk(resolve(dir, entry.name))
      } else {
        scanned++
        const ext = extname(entry.name).toLowerCase()
        if (ext) extensions.add(ext)
      }
    }
  }
  await walk(oldPath)
  for (const ext of extensions) {
    addAll(env.manager.getServersForFile(`${oldPath}/probe${ext}`))
  }
  return out
}

function coalesceWorkspaceEdits(
  perServer: Array<{ server: string; files: NormalizedFileEdits[] }>,
): { files: NormalizedFileEdits[]; overlapNotes: string[] } {
  const byUri = new Map<string, { edits: LspTextEditLike[]; owners: string[] }>()
  const overlapNotes: string[] = []
  for (const { server, files } of perServer) {
    for (const file of files) {
      const entry = byUri.get(file.uri) ?? { edits: [], owners: [] }
      let dropped = 0
      for (const edit of file.edits) {
        if (entry.edits.some(existing => lspRangesIntersect(existing.range, edit.range))) {
          dropped++
          continue
        }
        entry.edits.push(edit)
      }
      if (dropped > 0) {
        overlapNotes.push(
          `${server}: ${dropped} overlapping edit(s) in ${file.uri.slice(file.uri.lastIndexOf('/') + 1) || file.uri} yielded to ${entry.owners.join('+') || 'the prior claimant'}`,
        )
      }
      if (file.edits.length > dropped) entry.owners.push(server)
      byUri.set(file.uri, entry)
    }
  }
  return {
    files: [...byUri.entries()]
      .filter(([, v]) => v.edits.length > 0)
      .map(([uri, v]) => ({ uri, edits: v.edits })),
    overlapNotes,
  }
}

const renamePositionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() })

const renameTextEditSchema = z.object({
  range: z.object({ start: renamePositionSchema, end: renamePositionSchema }).refine(
    ({ start, end }) => end.line > start.line || (end.line === start.line && end.character >= start.character),
    'edit has end before start',
  ),
  newText: z.string(),
})

const renameUriSchema = z.string().refine(uri => {
  try {
    return isAbsolute(uriToFilePath(uri))
  } catch {
    return false
  }
}, 'invalid file URI')

const renameWorkspaceEditSchema = z.object({
  changes: z.record(renameUriSchema, z.array(renameTextEditSchema)).optional(),
  documentChanges: z.array(z.union([
    z.object({ textDocument: z.object({ uri: renameUriSchema }), edits: z.array(renameTextEditSchema) }),
    z.object({ kind: z.string() }),
  ])).optional(),
}).nullish()

async function prepareApplyFanOut(
  env: OpEnv,
  requesters: Array<{ name: string; request: () => Promise<WorkspaceEditLike | null | undefined> }>,
): Promise<
  | { ok: true; files: NormalizedFileEdits[]; snapshots: Map<string, string>; notes: string[] }
  | { ok: false; reason: string }
> {
  const snapshots = new Map<string, string>()
  const notes: string[] = []
  for (let round = 0; round < PREPARE_ROUNDS; round++) {
    const perServer: Array<{ server: string; files: NormalizedFileEdits[] }> = []
    for (const r of requesters) {
      let edit: WorkspaceEditLike | null | undefined
      try {
        edit = await r.request()
      } catch (error) {
        return { ok: false, reason: `${r.name}: willRenameFiles failed (${error instanceof Error ? error.message : String(error)})` }
      }
      const validated = renameWorkspaceEditSchema.safeParse(edit)
      if (!validated.success) {
        const issue = validated.error.issues[0]!
        return { ok: false, reason: `${r.name}: willRenameFiles returned a malformed edit (${issue.path.join('.') || 'result'}: ${issue.message})` }
      }
      const normalized = normalizeWorkspaceEdit(edit)
      if (!normalized.ok) {
        if (!/edit set is empty|server returned no edit/.test(normalized.reason)) {
          return { ok: false, reason: `${r.name}: willRenameFiles returned an invalid edit (${normalized.reason})` }
        }
        continue
      }
      perServer.push({ server: r.name, files: normalized.files })
    }
    const merged = coalesceWorkspaceEdits(perServer)
    notes.push(...merged.overlapNotes)
    const unsynced = merged.files.filter(file => !snapshots.has(uriToFilePath(file.uri)))
    if (unsynced.length === 0) {
      return { ok: true, files: merged.files, snapshots, notes }
    }
    for (const file of unsynced) {
      const abs = uriToFilePath(file.uri)
      try {
        snapshots.set(abs, await syncFileFromDisk(env.manager, abs))
      } catch (error) {
        return {
          ok: false,
          reason: `could not sync ${displayPathFor(env.cwd, abs)}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }
  return {
    ok: false,
    reason: `the edit did not stabilize after ${PREPARE_ROUNDS} rounds — the servers kept widening the touched-file set; nothing was written`,
  }
}

function advertisesFileOperation(
  server: LSPServerInstance,
  op: 'willRename' | 'didRename',
): boolean {
  const caps = server.capabilities as ServerCapabilities | undefined
  const fileOps = (caps?.workspace as { fileOperations?: Record<string, unknown> } | undefined)
    ?.fileOperations
  return Boolean(fileOps?.[op])
}

async function opPathRename(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const oldPath = env.absolutePath
  const display = displayPathFor(env.cwd, oldPath)
  if (!input.newPath || resolve(env.cwd, input.newPath) === resolve(oldPath)) {
    return {
      result: `LspMoveFile failed: newPath is required and must differ from filePath.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'invalid newPath',
      },
    }
  }
  const newPath = resolve(env.cwd, input.newPath)
  const newDisplay = displayPathFor(env.cwd, newPath)
  let isDirectory = false
  try {
    isDirectory = (await stat(oldPath)).isDirectory()
  } catch {
    return {
      result: `LspMoveFile failed: ${display} does not exist.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: 'source missing' },
    }
  }
  try {
    await stat(newPath)
    return {
      result: `LspMoveFile refused: Target already exists at ${newDisplay} — nothing moved.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'target exists — nothing moved',
      },
    }
  } catch {
  }

  const claimants = await pathRenameClaimants(env, oldPath, newPath, isDirectory)
  for (const c of claimants) {
    if (c.state !== 'running') await c.start().catch(() => {})
  }
  const askable = claimants.filter(c => advertisesFileOperation(c, 'willRename'))

  const oldUri = pathToFileURL(resolve(oldPath)).href
  const newUri = pathToFileURL(newPath).href

  let prepared: { ok: true; files: NormalizedFileEdits[]; snapshots: Map<string, string> }
  let supportNote: string
  const fanOutNotes: string[] = []
  if (askable.length > 0) {
    if (!isDirectory) await syncFileFromDisk(env.manager, oldPath).catch(() => {})
    const fan = await prepareApplyFanOut(
      env,
      askable.map(server => ({
        name: server.name,
        request: () =>
          server.sendRequest<WorkspaceEditLike | null>('workspace/willRenameFiles', {
            files: [{ oldUri, newUri }],
          }),
      })),
    )
    if (!fan.ok) {
      return {
        result: `LspMoveFile failed while preparing import edits: ${fan.reason}. Nothing was written or moved; all files are unchanged.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'import-edit preparation failed — all files unchanged',
        },
      }
    }
    fanOutNotes.push(...fan.notes)
    const editCount = fan.files.reduce((sum, file) => sum + file.edits.length, 0)
    if (fan.files.length > PATH_RENAME_FILE_CAP) {
      return {
        result: `LspMoveFile refused: the move would touch ${fan.files.length} files (cap ${PATH_RENAME_FILE_CAP}). Split the move into smaller steps, or move the file with Bash and fix imports incrementally.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `file cap exceeded (${fan.files.length})`,
        },
      }
    }
    prepared = { ok: true, files: fan.files, snapshots: fan.snapshots }
    supportNote =
      editCount === 0
        ? `${askable.map(s => s.name).join(' + ')} reported no import edits for this move.`
        : `${editCount} import-updating edit(s) computed by ${askable.map(s => s.name).join(' + ')}.`
  } else if (claimants.length > 0) {
    prepared = { ok: true, files: [], snapshots: new Map() }
    supportNote = `${claimants.map(c => c.name).join(' + ')} claim${claimants.length === 1 ? 's' : ''} the file type but none advertises path-rename intelligence (workspace.fileOperations.willRename) — the ${isDirectory ? 'directory' : 'file'} moves without import updates.`
  } else {
    prepared = { ok: true, files: [], snapshots: new Map() }
    supportNote = `No language server claims this ${isDirectory ? "directory's contents" : 'file'} — the ${isDirectory ? 'directory' : 'file'} moves without import updates.`
  }

  const preparedFiles = prepared.files
  const preparedSnapshots = prepared.snapshots
  const notesBlock = fanOutNotes.length > 0 ? `\n${fanOutNotes.map(n => `note: ${n}`).join('\n')}` : ''
  if (input.apply !== true) {
    const set = planFiles(preparedFiles, preparedSnapshots)
    if (!set.ok) {
      return {
        result: `LspMoveFile failed while planning the import edits: ${set.reason}. Nothing was moved.`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: { outcome: 'failed', changedPaths: [], evidence: 'edit set ambiguous — nothing moved' },
      }
    }
    const token = set.planned.length > 0 ? planTokenOf(set.planned) : undefined
    const editPreview =
      preparedFiles.length > 0
        ? `\n${formatEditPreview(
            preparedFiles,
            uri => preparedSnapshots.get(uriToFilePath(uri)),
            uri => displayPathFor(env.cwd, uriToFilePath(uri)),
          )}`
        : ''
    const rerun =
      token !== undefined
        ? `plan: ${token} — re-run with apply: true, plan: "${token}" to move (refused if any of these files changes first).`
        : 'Re-run with apply: true to move.'
    return {
      result: `Move: ${display} → ${newDisplay}\n${supportNote}${notesBlock}${editPreview}\nPreview only — nothing moved, nothing written. ${rerun}`,
      resultCount: preparedFiles.reduce((sum, file) => sum + file.edits.length, 0),
      fileCount: preparedFiles.length,
      applied: false,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: 'move previewed, nothing written',
        details: { preview: true, ...(token !== undefined ? { plan: token } : {}) },
      },
      ...(preparedFiles.length > 0
        ? {
            changeView: changeViewOf(
              'pathRename',
              'proposed',
              env.cwd,
              preparedFiles,
              preparedSnapshots,
            ),
            ...editRowsFor(env, preparedFiles, preparedSnapshots),
          }
        : {}),
      ...(token !== undefined ? { plan: token } : {}),
    }
  }

  const permissionContext = env.context.getAppState().toolPermissionContext
  for (const endpoint of [oldPath, newPath]) {
    const decision = checkWritePermissionForTool(
      env.tool,
      { ...env.input, filePath: endpoint },
      permissionContext,
    ) as { behavior: string }
    const endpointDisplay = displayPathFor(env.cwd, endpoint)
    if (decision.behavior === 'deny') {
      return {
        result: `LspMoveFile refused: ${endpointDisplay} is denied by a rule. Nothing moved.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'endpoint denied — nothing moved',
        },
      }
    }
    if (decision.behavior !== 'allow' && !pathInAllowedWorkingPath(endpoint, permissionContext) && endpoint !== env.absolutePath && !postureBypassesAsks(permissionContext) && await env.requestWritePermission?.(endpoint) !== true) {
      return {
        result: `LspMoveFile refused: permission to write ${endpointDisplay} was not granted. Nothing moved.`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: 'endpoint out of scope — nothing moved',
        },
      }
    }
  }

  let editedPaths: string[] = []
  if (prepared.files.length > 0) {
    const applied = await applyPrepared(env, 'pathRename', prepared.files, prepared.snapshots)
    if (applied.output.effect.outcome === 'failed') {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved.`,
      }
    }
    if (applied.output.effect.outcome === 'indeterminate' && applied.output.applied !== true) {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved — resolve the divergence first.`,
      }
    }
    editedPaths = applied.writtenPaths
    if (applied.output.effect.outcome === 'indeterminate') {
      return {
        ...applied.output,
        result: `${applied.output.result}\nThe file was NOT moved — re-run LspMoveFile once the servers settle.`,
      }
    }
  }

  try {
    await mkdir(dirname(newPath), { recursive: true })
    try {
      await renameWithWin32Retry(oldPath, newPath)
    } catch (error) {
      if ((error as { code?: string }).code === 'EXDEV' && !isDirectory) {
        const oldBytes = await readFile(oldPath)
        await writeFile(newPath, oldBytes)
        await unlink(oldPath)
      } else if ((error as { code?: string }).code === 'EXDEV') {
        throw new Error(
          'cross-device directory move is not supported — move the tree with Bash (cp -R + rm) and re-run imports per file',
        )
      } else {
        throw error
      }
    }
  } catch (error) {
    return {
      result:
        `LspMoveFile INDETERMINATE: the import edits landed but the move itself failed (${error instanceof Error ? error.message : String(error)}). ` +
        `${display} still exists with updated imports pointing at the NEW path — move it manually or re-run.`,
      resultCount: editedPaths.length,
      fileCount: editedPaths.length,
      applied: true,
      effect: {
        outcome: 'indeterminate',
        changedPaths: editedPaths,
        evidence: 'edits landed; move failed',
      },
    }
  }

  if (!isDirectory) {
    try {
      await env.manager.closeFile(oldPath)
    } catch (error) {
      logForDebugging(`lsp ops: pathRename didClose failed: ${String(error)}`)
    }
  }
  for (const server of claimants) {
    if (!advertisesFileOperation(server, 'didRename')) continue
    try {
      await server.sendNotification('workspace/didRenameFiles', {
        files: [{ oldUri, newUri }],
      })
    } catch (error) {
      logForDebugging(`lsp ops: didRenameFiles to ${server.name} failed: ${String(error)}`)
    }
  }
  let movedText = ''
  if (!isDirectory) {
    try {
      movedText = await readFile(newPath, 'utf8')
      await env.manager.openFile(newPath, movedText)
    } catch (error) {
      logForDebugging(`lsp ops: post-move open failed: ${String(error)}`)
    }
  }
  try {
    const readFileState = env.context.readFileState
    if (isDirectory) {
      const root = resolve(oldPath)
      const prefix = root.endsWith(sep) ? root : `${root}${sep}`
      for (const [key, value] of [...readFileState.entries()]) {
        if (key === root || key.startsWith(prefix)) {
          readFileState.delete(key)
          readFileState.set(newPath + key.slice(root.length), value)
        }
      }
    } else {
      readFileState.delete(oldPath)
      const stats = await stat(newPath)
      readFileState.set(newPath, {
        content: movedText.replaceAll('\r\n', '\n'),
        timestamp: Math.floor(stats.mtimeMs),
        offset: undefined,
        limit: undefined,
      })
    }
  } catch (error) {
    logForDebugging(`lsp ops: readFileState follow failed: ${String(error)}`)
  }

  const postMoveNote = isDirectory
    ? 'Directory moved — run diagnostics on the touched files to verify.'
    : await (async () => {
        const stabilization = await awaitDiagnosticStabilization(env.manager, newPath)
        return stabilization.state === 'fresh' || stabilization.state === 'unchanged'
          ? `Post-move diagnostics: ${stabilization.errors} error(s), ${stabilization.warnings} warning(s).`
          : `post-move diagnostics ${stabilization.state} — verify the move with a real check.`
      })()
  const editedList =
    editedPaths.length > 0
      ? `\nEdited: ${editedPaths.map(p => displayPathFor(env.cwd, p)).join(', ')}`
      : ''
  const changedPaths = [...new Set([...editedPaths, oldPath, newPath])]
  return {
    result: `Moved ${display} → ${newDisplay}\n${supportNote}${notesBlock}${editedList}\n${postMoveNote}`,
    resultCount: changedPaths.length,
    fileCount: changedPaths.length,
    applied: true,
    effect: {
      outcome: 'succeeded',
      changedPaths,
      evidence: `moved + ${editedPaths.length} file(s) edited`,
      details: { postMove: postMoveNote },
    },
  }
}

async function opFixDiagnostic(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  await syncFileFromDisk(env.manager, env.absolutePath)
  const before = await pullFileDiagnostics(env.manager, env.absolutePath)
  if (before.kind === 'unsupported') {
    return {
      result: `fixDiagnostic needs pull diagnostics, which the language server for ${display} does not support — use codeActions directly.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'pull diagnostics unsupported',
      },
    }
  }
  if (before.kind === 'protocol-violation') {
    return {
      result: `fixDiagnostic is indeterminate for ${display}: ${before.detail} — cannot establish the before picture.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'indeterminate',
        changedPaths: [],
        evidence: 'before picture indeterminate',
      },
    }
  }
  if (before.kind === 'no-claimant') {
    const extension = extname(env.absolutePath).toLowerCase()
    return {
      result:
        `fixDiagnostic is unavailable for ${display}: no language server claims '${extension}'. ` +
        remedyForUnclaimedExtension(extension, env.cwd),
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: `no language server claims '${extension}'`,
      },
    }
  }
  if (before.kind === 'unavailable') {
    const words = unavailableWords(before.failed, env.absolutePath, env.cwd)
    return {
      result: `fixDiagnostic was not run for ${display}: ${words.what}.${words.remedy ? ` What helps: ${words.remedy}.` : ''}`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: words.what,
        details: { serverFailures: words.servers },
      },
    }
  }
  const range = inputRange(input)
  const targets = before.items.filter(item => lineRangesOverlap(item.range, range))
  if (targets.length === 0) {
    return {
      result: `No diagnostics at ${display}:${input.line ?? 1} — nothing to fix.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'nothing to fix',
      },
    }
  }
  const beforeCounts = countBySeverity(before.items)
  const picture = `${targets.length} diagnostic(s) at the position (file has ${beforeCounts.errors} error(s)):\n${targets
    .map(item => `  ${formatDiagnosticLine(display, item)}`)
    .join('\n')}`

  const fixRerunHint =
    'Re-run fixDiagnostic with apply: true and actionId to apply a fix (or apply: true alone when exactly one edit-shaped fix is offered).'

  if (input.apply !== true) {
    const listing = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: false },
    })
    const rewritten = listing.result.replace(CODE_ACTION_RERUN_HINT, fixRerunHint)
    return {
      ...listing,
      result: `${picture}\n${rewritten}`,
    }
  }

  const delegate = await opCodeActions({
    ...env,
    input: { ...input, operation: 'codeActions', apply: true },
  })
  let applied = delegate
  if (
    input.actionId === undefined &&
    delegate.effect.outcome === 'failed' &&
    delegate.result.includes('apply: true requires actionId')
  ) {
    const listing = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: false },
    })
    const editRows = [...listing.result.matchAll(/id:(ca-[0-9a-f]{8}).*— edit$/gm)]
    if (editRows.length !== 1) {
      return {
        result: `${picture}\nfixDiagnostic needs a selection: ${editRows.length} edit-shaped fixes are offered. ${listing.result.replace(CODE_ACTION_RERUN_HINT, fixRerunHint)}`,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'failed',
          changedPaths: [],
          evidence: `selection required (${editRows.length} candidates)`,
        },
      }
    }
    applied = await opCodeActions({
      ...env,
      input: { ...input, operation: 'codeActions', apply: true, actionId: editRows[0]![1]! },
    })
  }
  if (applied.applied !== true) {
    return applied
  }

  let movement: string
  let afterErrors: number | undefined
  try {
    const after = await pullFileDiagnostics(env.manager, env.absolutePath)
    if (after.kind === 'fresh' || after.kind === 'unchanged') {
      afterErrors = countBySeverity(after.items).errors
      const suffix =
        afterErrors < beforeCounts.errors
          ? ' ✓'
          : afterErrors > beforeCounts.errors
            ? ' — the fix INTRODUCED errors, inspect'
            : ' (unchanged count)'
      movement = `errors before: ${beforeCounts.errors} → after: ${afterErrors}${suffix}`
    } else {
      movement = `errors before: ${beforeCounts.errors} → after: indeterminate (re-pull ${after.kind})`
    }
  } catch (error) {
    movement = `errors before: ${beforeCounts.errors} → after: indeterminate (re-pull failed: ${error instanceof Error ? error.message : String(error)})`
  }
  return {
    ...applied,
    result: `${applied.result}\n${movement}`,
    effect: {
      ...applied.effect,
      evidence: `${applied.effect.evidence}; ${movement}`,
      details: {
        ...(applied.effect.details ?? {}),
        beforeErrors: beforeCounts.errors,
        ...(afterErrors !== undefined ? { afterErrors } : {}),
      },
    },
  }
}

type FormatWant = 'formatDocument' | 'formatRange' | 'organizeImports'

function advertisesWant(capabilities: ServerCapabilities | undefined, want: FormatWant): boolean {
  if (want === 'formatDocument') return Boolean(capabilities?.documentFormattingProvider)
  if (want === 'formatRange') return Boolean(capabilities?.documentRangeFormattingProvider)
  const provider = capabilities?.codeActionProvider
  if (!provider || typeof provider === 'boolean') return false
  const kinds = (provider as { codeActionKinds?: string[] }).codeActionKinds ?? []
  return kinds.some(
    kind => kind === 'source.organizeImports' || kind.startsWith('source.organizeImports.'),
  )
}

function capabilityNameFor(want: FormatWant): string {
  if (want === 'formatDocument') return 'documentFormatting'
  if (want === 'formatRange') return 'documentRangeFormatting'
  return 'source.organizeImports code actions'
}

async function resolveFormatOwner(
  env: OpEnv,
  want: FormatWant,
): Promise<{ owner: LSPServerInstance } | { refusal: string }> {
  const claimants = env.manager.getServersForFile(env.absolutePath)
  if (claimants.length === 0) {
    return { refusal: `No language server claims ${displayPathFor(env.cwd, env.absolutePath)}.` }
  }
  const reports: string[] = []
  for (const claimant of claimants) {
    if (claimant.state !== 'running') {
      try {
        if (claimant.state === 'stopping') await claimant.stop()
        await claimant.start()
      } catch (error) {
        reports.push(
          `${claimant.name}: failed to start (${error instanceof Error ? error.message : String(error)})`,
        )
        continue
      }
    }
    if (advertisesWant(claimant.capabilities as ServerCapabilities | undefined, want)) {
      return { owner: claimant }
    }
    reports.push(`${claimant.name}: does not advertise ${capabilityNameFor(want)}`)
  }
  const extension = extname(env.absolutePath).toLowerCase()
  const pythonRemedy =
    extension === '.py' || extension === '.pyi'
      ? '\nFor Python, install ruff (the mercury-ruff companion advertises formatting and import organisation once the binary is on PATH).'
      : ''
  return {
    refusal: `No claimant can ${want} this file:\n${reports.map(line => `  ${line}`).join('\n')}${pythonRemedy}`,
  }
}

async function opFormatFamily(env: OpEnv, want: FormatWant): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  if (
    want === 'formatRange' &&
    (input.line === undefined ||
      input.character === undefined ||
      input.endLine === undefined ||
      input.endCharacter === undefined)
  ) {
    return {
      result: `formatRange failed: line, character, endLine and endCharacter are all required.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'missing range fields',
      },
    }
  }
  const resolved = await resolveFormatOwner(env, want)
  if ('refusal' in resolved) {
    return {
      result: resolved.refusal,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no capable owner',
      },
    }
  }
  const owner = resolved.owner
  const uri = pathToFileURL(resolve(env.absolutePath)).href

  const requestEdit = async (): Promise<WorkspaceEditLike | null> => {
    if (want === 'organizeImports') {
      const wholeFileText = await readFile(env.absolutePath, 'utf8')
      const wholeFileLines = wholeFileText.split('\n')
      const actions = await owner.sendRequest<Array<WireCodeAction | null> | null>(
        'textDocument/codeAction',
        {
          textDocument: { uri },
          range: {
            start: { line: 0, character: 0 },
            end: {
              line: wholeFileLines.length - 1,
              character: wholeFileLines[wholeFileLines.length - 1]!.length,
            },
          },
          context: { diagnostics: [], only: ['source.organizeImports'] },
        },
      )
      const action = (actions ?? []).find(
        (candidate): candidate is WireCodeAction =>
          candidate !== null &&
          typeof candidate === 'object' &&
          typeof candidate.title === 'string' &&
          (candidate.kind === 'source.organizeImports' ||
            (candidate.kind ?? '').startsWith('source.organizeImports')),
      )
      if (!action) return { changes: {} }
      if (action.edit) return action.edit
      const capabilities = owner.capabilities as ServerCapabilities | undefined
      const resolveProvider = Boolean(
        (capabilities?.codeActionProvider as { resolveProvider?: boolean } | undefined)
          ?.resolveProvider,
      )
      if (resolveProvider) {
        const resolvedAction = await owner.sendRequest<WireCodeAction | null>(
          'codeAction/resolve',
          action,
        )
        if (resolvedAction?.edit) return resolvedAction.edit
      }
      return { changes: {} }
    }
    const method =
      want === 'formatDocument' ? 'textDocument/formatting' : 'textDocument/rangeFormatting'
    const params: Record<string, unknown> = {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    }
    if (want === 'formatRange') {
      params.range = {
        start: { line: input.line! - 1, character: input.character! - 1 },
        end: { line: input.endLine! - 1, character: input.endCharacter! - 1 },
      }
    }
    const edits = await owner.sendRequest<LspTextEditLike[] | null>(method, params)
    return { changes: { [uri]: edits ?? [] } }
  }

  await syncFileFromDisk(env.manager, env.absolutePath)
  const prepared = await prepareApply(env, requestEdit)
  if (!prepared.ok) {
    if (/edit set is empty/.test(prepared.reason)) {
      const message =
        want === 'organizeImports'
          ? `Imports already organized (${owner.name} returned no edits) — ${display} is unchanged.`
          : `Already formatted (${owner.name} returned no edits) — ${display} is unchanged.`
      return {
        result: message,
        resultCount: 0,
        fileCount: 0,
        applied: false,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'no edits needed',
        },
      }
    }
    return {
      result: `LspFormat failed: ${prepared.reason}`,
      resultCount: 0,
      fileCount: 0,
      applied: false,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'preparation failed — nothing written',
      },
    }
  }
  if (input.apply !== true) {
    return previewOf(env, want, prepared.files, prepared.snapshots, `to write (${owner.name} is the formatting owner)`)
  }
  const applied = await applyPrepared(env, want, prepared.files, prepared.snapshots)
  return applied.output
}

async function opMoveSymbol(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  const failed = (result: string, evidence: string): MercuryLspOpOutput => ({
    result,
    resultCount: 0,
    fileCount: 0,
    applied: false,
    effect: { outcome: 'failed', changedPaths: [], evidence },
  })
  const rawTarget = input.targetPath?.trim() ?? ''
  if (rawTarget === '') {
    return failed(
      'moveSymbol needs targetPath — the file the declaration moves to (created when it does not exist, appended to when it does).',
      'missing targetPath',
    )
  }
  const target = resolve(env.cwd, expandPath(rawTarget))
  if (target === resolve(env.absolutePath)) {
    return failed(`LspMoveSymbol failed: targetPath must differ from filePath (${display} cannot move into itself).`, 'target is the source')
  }
  const claimant = env.manager.getServerForFile(env.absolutePath)
  if (!claimant) {
    const extension = extname(env.absolutePath).toLowerCase()
    return {
      result: `No language server claims ${display} (extension '${extension}') — nothing can move it. ${remedyForUnclaimedExtension(extension)}`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: `no language server claims '${extension}'` },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  const position = { line: (input.line ?? 1) - 1, character: (input.character ?? 1) - 1 }
  const requestEdit = (): Promise<WorkspaceEditLike | null | undefined> =>
    env.manager.sendRequest<WorkspaceEditLike | null>(env.absolutePath, 'mercury/moveToFile', {
      textDocument: { uri },
      position,
      targetUri: pathToFileURL(target).href,
    })
  const prepared = await prepareApply(env, requestEdit, { allowCreate: true })
  if (!prepared.ok) {
    if (isMethodNotFoundError(prepared.reason)) {
      return {
        result: `The ${claimant.name} server does not offer a symbol move — the TypeScript and JavaScript lane (mercury-ts) does; for other languages move the declaration with Edit and fix the imports with LspRename or LspMoveFile.`,
        resultCount: 0,
        fileCount: 0,
        effect: { outcome: 'no-change', changedPaths: [], evidence: 'symbol move unsupported by the claimant' },
      }
    }
    return failed(`Move failed: ${prepared.reason}`, 'move preparation failed — nothing written')
  }
  if (input.apply !== true) {
    return previewOf(env, 'moveSymbol', prepared.files, prepared.snapshots, `to move the declaration to ${displayPathFor(env.cwd, target)}`)
  }
  const applied = await applyPrepared(env, 'moveSymbol', prepared.files, prepared.snapshots)
  return applied.output
}

const RAW_RESULT_CHAR_CAP = 20_000

const RAW_REQUEST_EDIT_CLASS: Record<string, string> = {
  'textDocument/rename': 'use LspRename — its result rides the drift-safe apply transaction',
  'workspace/willRenameFiles': 'use LspMoveFile — the move and its import edits ride one transaction',
  'workspace/executeCommand': 'it runs a server-side command that can edit the workspace outside the transaction — use LspCodeAction with apply: true',
  'textDocument/codeAction': 'use LspCodeAction — resolved edits ride the apply transaction',
  'codeAction/resolve': 'use LspCodeAction — resolved edits ride the apply transaction',
  'textDocument/formatting': 'use LspFormat',
  'textDocument/rangeFormatting': 'use LspFormat',
  'workspace/applyEdit': 'a server→client request — a client cannot send it',
}

async function opCapabilities(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  const server = env.manager.getServerForFile(env.absolutePath)
  if (!server) {
    return {
      result: `No language server claims ${display} — nothing to dump. op:"serverStatus" lists the configured servers.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: 'no claimant' },
    }
  }
  await env.manager.ensureServerStarted(env.absolutePath)
  const caps = server.capabilities
  if (!caps) {
    return {
      result: `${server.name} claims ${display} but reports no capabilities yet (state: ${server.state}).`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: `no capabilities (state ${server.state})` },
    }
  }
  const text = JSON.stringify(caps, null, 2)
  const clipped = text.length > RAW_RESULT_CHAR_CAP
  return {
    result:
      `${server.name} capabilities for ${display}:\n` +
      (clipped ? `${text.slice(0, RAW_RESULT_CHAR_CAP)}\n… (${text.length - RAW_RESULT_CHAR_CAP} more chars)` : text),
    resultCount: Object.keys(caps).length,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `dumped ${Object.keys(caps).length} capability key(s) from ${server.name}`,
    },
  }
}

async function opRawRequest(env: OpEnv): Promise<MercuryLspOpOutput> {
  const input = env.input
  const display = displayPathFor(env.cwd, env.absolutePath)
  const method = input.method ?? ''
  const editClassReason = RAW_REQUEST_EDIT_CLASS[method]
  if (editClassReason !== undefined) {
    return {
      result: `LspRequest refused: '${method}' is an edit-class method — ${editClassReason}. Nothing was sent.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: `edit-class method refused (${method})` },
    }
  }
  let params: unknown = undefined
  if (input.params !== undefined && input.params !== '') {
    try {
      params = JSON.parse(input.params)
    } catch (error) {
      return {
        result: `LspRequest failed: params is not valid JSON (${error instanceof Error ? error.message : String(error)}). Nothing was sent.`,
        resultCount: 0,
        fileCount: 0,
        effect: { outcome: 'failed', changedPaths: [], evidence: 'params JSON parse failed' },
      }
    }
  }
  const server = env.manager.getServerForFile(env.absolutePath)
  if (!server) {
    return {
      result: `No language server claims ${display} — LspRequest has no target.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: 'no claimant' },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  try {
    const response = await server.sendRequest<unknown>(method, params ?? {})
    const text = JSON.stringify(response, null, 2) ?? 'null'
    const clipped = text.length > RAW_RESULT_CHAR_CAP
    return {
      result:
        `${server.name} · ${method}:\n` +
        (clipped ? `${text.slice(0, RAW_RESULT_CHAR_CAP)}\n… (${text.length - RAW_RESULT_CHAR_CAP} more chars)` : text) +
        `\n\nRaw protocol response — nothing was applied. Edit-returning behaviour lives in the typed operations.`,
      resultCount: 1,
      fileCount: 1,
      effect: {
        outcome: 'succeeded',
        changedPaths: [],
        evidence: `raw ${method} answered by ${server.name}`,
        details: { method, server: server.name },
      },
    }
  } catch (error) {
    return {
      result: `LspRequest ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'failed', changedPaths: [], evidence: `raw ${method} failed` },
    }
  }
}

export async function runMercuryLspOp(env: OpEnv): Promise<MercuryLspOpOutput> {
  try {
    await env.manager.revalidateOpenDocuments()
  } catch {
  }
  switch (env.input.operation) {
    case 'capabilities':
      return opCapabilities(env)
    case 'rawRequest':
      return opRawRequest(env)
    case 'diagnostics':
      return opDiagnostics(env)
    case 'switchSourceHeader':
      return opSwitchSourceHeader(env)
    case 'rename':
      return opRename(env)
    case 'codeActions':
      return opCodeActions(env)
    case 'typeDefinition':
      return opTypeDefinition(env)
    case 'serverStatus':
      return opServerStatus(env)
    case 'workspaceDiagnostics':
      return opWorkspaceDiagnostics(env)
    case 'pathRename':
      return opPathRename(env)
    case 'fixDiagnostic':
      return opFixDiagnostic(env)
    case 'formatDocument':
      return opFormatFamily(env, 'formatDocument')
    case 'formatRange':
      return opFormatFamily(env, 'formatRange')
    case 'organizeImports':
      return opFormatFamily(env, 'organizeImports')
    case 'moveSymbol':
      return opMoveSymbol(env)
  }
}
