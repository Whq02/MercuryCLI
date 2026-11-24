import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { LSP_ONE_LINE_MAX } from '../../../integrations/lsp/failureWords.js'
import { isLspStartFailure } from '../../../integrations/lsp/LSPServerInstance.js'
import { collapseAndClip } from '../../../platform/text/strings.js'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { WORKSPACE_DIAG_FILE_CAP, IGNORED_WALK_DIRS, displayPathFor, sortDiagnostics, formatDiagnosticLine, countBySeverity, syncFileFromDisk } from './shared.js'
import { remedyForUnclaimedExtension, pullFileDiagnostics, unavailableWords } from './pull.js'

export async function opWorkspaceDiagnostics(env: OpEnv): Promise<MercuryLspOpOutput> {
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
      await syncFileFromDisk(env.manager, abs, env.context)
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
