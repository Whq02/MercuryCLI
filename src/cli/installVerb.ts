import { homedir } from 'node:os'
import { formatUninstallReport, resolveLayoutRoots, uninstallLayout } from 'src/services/privateChannel/installLayout.js'
import { describePathTarget, type PathEntryOutcome } from 'src/services/privateChannel/installPath.js'
import { describeInstall, performInstall, type Progress } from 'src/services/privateChannel/updateService.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { cliError, cliOk } from './exit.js'

export interface InstallCliOptions {
  dryRun?: boolean
  uninstall?: boolean
  force?: boolean
  json?: boolean
}

const progressToStderr: Progress = (state, detail) => {
  console.error(detail ? `${state}: ${detail}` : state)
}

const emitJson = (value: unknown): never => cliOk(jsonStringify(value, null, 1) ?? '{}')
const failJson = (value: unknown): never => cliError(jsonStringify(value, null, 1) ?? '{}')

export function describePathOutcome(path: PathEntryOutcome, isWindows: boolean, home: string = homedir(), repeat = false): string {
  const targets = (list: string[]): string => list.map(t => describePathTarget(t, home)).join(' and ')
  const openNew = isWindows ? 'open a new terminal' : `open a new terminal, or run: ${path.line}`
  switch (path.state) {
    case 'on-path':
      return `PATH: ${path.dir} is already on your PATH`
    case 'reachable':
      return `PATH: unchanged — a \`mercury\` command already runs from ${path.resolved}`
    case 'present': {
      const lists = isWindows ? 'your user PATH lists it' : `${targets(path.targets)} ${path.targets.length > 1 ? 'name' : 'names'} it`
      if (repeat) return `PATH: ${path.dir} is already on your PATH — ${lists}`
      return isWindows
        ? `PATH: your user PATH already lists ${path.dir} — ${openNew}`
        : `PATH: ${targets(path.targets)} already ${path.targets.length > 1 ? 'name' : 'names'} ${path.dir} — ${openNew}`
    }
    case 'would-write':
      return isWindows ? `PATH: would add ${path.dir} to your user PATH` : `PATH: would add ${path.dir} in ${targets(path.targets)}`
    case 'written':
      return isWindows ? `PATH: added ${path.dir} to your user PATH — ${openNew}` : `PATH: added ${path.dir} in ${targets(path.targets)} — ${openNew}`
    case 'refused':
      return `note: ${path.dir} is not on your PATH — ${path.reason}; add it yourself: ${path.line}`
  }
}

export async function installVerb(options: InstallCliOptions = {}): Promise<never> {
  if (options.dryRun && options.uninstall) {
    console.error('mercury install: --dry-run and --uninstall are mutually exclusive')
    process.exit(2)
  }
  const roots = resolveLayoutRoots()

  if (options.uninstall) {
    const report = uninstallLayout(roots)
    if (options.json) return emitJson({ mode: 'uninstall', ...report })
    return cliOk(formatUninstallReport(roots, report))
  }

  if (options.dryRun) {
    const described = describeInstall(roots)
    if (options.json) return emitJson({ mode: 'dry-run', ...described })
    if (described.state === 'dry-run') {
      return cliOk(
        [
          `would install version: ${described.version ?? '(cannot determine — see note)'}`,
          `would install to:      ${described.wouldInstallTo}`,
          `stable command:        ${described.shimPath}`,
          `runtime:               ${described.runtime}`,
          describePathOutcome(described.path, roots.isWindows),
          `note: ${described.note}`,
        ].join('\n'),
      )
    }
    return cliError('dry-run could not describe the install')
  }

  const progress: Progress = options.json ? () => {} : progressToStderr
  const result = await performInstall(roots, progress, { force: options.force })
  if (options.json) return result.state === 'installed' ? emitJson({ mode: 'install', ...result }) : failJson({ mode: 'install', ...result })
  if (result.state === 'dry-run') return cliError('install produced an unexpected dry-run result')
  if (result.state === 'installed') {
    const lines = [
      `installed: ${result.version} → ${result.versionDir}${result.changed ? '' : ' (already present — no bytes changed)'}`,
      `active version: ${result.version} (pointer: ${roots.versionsDir})`,
    ]
    switch (result.shim.state) {
      case 'written':
        lines.push(`stable command: ${result.shim.path}${result.shim.backupPath ? ` (previous file kept at ${result.shim.backupPath})` : ''}`)
        break
      case 'current':
        lines.push(`stable command: ${result.shim.path} (already current)`)
        break
      case 'refused-foreign':
        lines.push(`stable command NOT written: ${result.shim.note}`)
        break
    }
    lines.push(describePathOutcome(result.path, roots.isWindows, homedir(), !result.changed))
    lines.push('configuration and sessions live in your Mercury home and were not touched')
    lines.push('next: `mercury update --check` keeps this install current (no GitHub sign-in needed)')
    return cliOk(lines.join('\n'))
  }
  return cliError(`install refused: ${result.reason}\n  ${result.remedy}`)
}
