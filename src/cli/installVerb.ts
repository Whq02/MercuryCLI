// ============================================================================
//  src/cli/installVerb.ts — `mercury install`, the SELF-ADOPT verb
//
//
//  Run from an extracted release archive's own launcher, it installs that
//  payload user-locally (versioned directory + atomic current pointer) and
//  places ONE stable `mercury` command in a conventional user-local bin —
//  idempotent, no administrator access, never npm, never a source checkout.
//  `--uninstall` removes managed binaries only; configuration and sessions
//  (the ~/.mercury config home) are never touched. A pre-existing NON-managed
//  command at the stable path (e.g. the operator's own launcher) is refused,
//  not clobbered — `--force` replaces it with a .bak kept.
// ============================================================================
import { formatUninstallReport, resolveLayoutRoots, uninstallLayout } from 'src/services/privateChannel/installLayout.js'
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
  // biome-ignore lint/suspicious/noConsole: CLI progress belongs on stderr
  console.error(detail ? `${state}: ${detail}` : state)
}

const emitJson = (value: unknown): never => cliOk(jsonStringify(value, null, 1) ?? '{}')
const failJson = (value: unknown): never => cliError(jsonStringify(value, null, 1) ?? '{}')

export async function installVerb(options: InstallCliOptions = {}): Promise<never> {
  if (options.dryRun && options.uninstall) {
    // biome-ignore lint/suspicious/noConsole: usage error belongs on stderr
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
    if (!result.binDirOnPath) {
      lines.push(`note: add ${roots.binDir} to your PATH to use the \`mercury\` command everywhere`)
    }
    lines.push('configuration and sessions live in your Mercury home and were not touched')
    lines.push('next: `mercury update --check` keeps this install current (needs your own gh sign-in)')
    return cliOk(lines.join('\n'))
  }
  return cliError(`install refused: ${result.reason}\n  ${result.remedy}`)
}
