import { extname } from 'node:path'
import { isLspStartFailure } from '../../../integrations/lsp/LSPServerInstance.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, sortDiagnostics, formatDiagnosticLine, countBySeverity, syncFileFromDisk } from './shared.js'
import { type PullDiagnosticsOutcome, remedyForUnclaimedExtension, pullFileDiagnostics, unavailableWords } from './pull.js'

export async function opDiagnostics(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  let pulled: PullDiagnosticsOutcome
  try {
    await syncFileFromDisk(env.manager, env.absolutePath, env.context)
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
