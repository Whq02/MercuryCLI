import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { type LSPServerInstance } from '../../../integrations/lsp/LSPServerInstance.js'
import { type LspTextEditLike, type WorkspaceEditLike } from '../../../integrations/lsp/workspaceEditApply.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, syncFileFromDisk } from './shared.js'
import { prepareApply } from './prepare.js'
import { previewOf } from './preview.js'
import { applyPrepared } from './apply.js'
import type { WireCodeAction } from './codeActions.js'

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

export async function opFormatFamily(env: OpEnv, want: FormatWant): Promise<MercuryLspOpOutput> {
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
