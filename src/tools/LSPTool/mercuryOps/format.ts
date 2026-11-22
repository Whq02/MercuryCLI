import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities } from 'vscode-languageserver-protocol'
import { type LSPServerInstance } from '../../../services/lsp/LSPServerInstance.js'
import { type LspTextEditLike, type WorkspaceEditLike } from '../../../services/lsp/workspaceEditApply.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, syncFileFromDisk } from './shared.js'
import { prepareApply } from './prepare.js'
import { previewOf } from './preview.js'
import { applyPrepared } from './apply.js'
import type { WireCodeAction } from './codeActions.js'
import { notBuilt } from '../../../pi/holes.js'

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
  return notBuilt('src/tools/LSPTool/mercuryOps/format.ts:69')
}
