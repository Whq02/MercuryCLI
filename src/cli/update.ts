import { reconcileManagedShims, resolveLayoutRoots, type LayoutRoots } from 'src/services/privateChannel/installLayout.js'
import { commandOnPath, commandOnPathWarning, npmWrapperOnPath } from 'src/services/privateChannel/installPath.js'
import {
  askYesNo,
  installerConsentQuestion,
  installerRoadWords,
  readVersionAfterUpgrade,
  runInstallerUpgrade,
} from 'src/services/privateChannel/installerUpgrade.js'
import {
  foreignInstallerOf,
  NPM_WRAPPER_ROAD_WORDS,
  resolveInstallProvenance,
  type ForeignInstaller,
  type InstallProvenanceV1,
} from 'src/services/privateChannel/installProvenance.js'
import {
  channelStatus,
  checkForUpdate,
  performRollback,
  performUpdate,
  statusRuntimeLine,
  type Progress,
} from 'src/services/privateChannel/updateService.js'
import { describeChannelRoad } from 'src/services/privateChannel/channelTransport.js'
import { formatBootResidueWarning, readBootAttemptResidue } from 'src/substrate/bootBeacon.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { cliError, cliOk } from './exit.js'

export interface UpdateCliOptions {
  check?: boolean
  status?: boolean
  rollback?: boolean
  allowUnsigned?: boolean
  yes?: boolean
  json?: boolean
}

const progressToStderr: Progress = (state, detail) => {
  console.error(detail ? `${state}: ${detail}` : state)
}

const emitJson = (value: unknown): never => cliOk(jsonStringify(value, null, 1) ?? '{}')
const failJson = (value: unknown): never => cliError(jsonStringify(value, null, 1) ?? '{}')

function provenanceStatusWords(p: InstallProvenanceV1, npmWrapper: string | null): string {
  const installer = foreignInstallerOf(p)
  if (installer) return `installed by ${installer.name} at ${p.activeRoot} — ${installerRoadWords(installer)}`
  switch (p.kind) {
    case 'managed':
      return `installed by \`mercury install\` or the install script at ${p.activeRoot} — \`mercury update\` manages it${npmWrapper === null ? '' : ` (${NPM_WRAPPER_ROAD_WORDS})`}`
    case 'extracted-release':
      return `a release archive run in place at ${p.activeRoot} — \`mercury update\` manages the install under the versions directory`
    case 'development':
      return `a source checkout at ${p.activeRoot} — rebuild it with \`git pull && bun run build.ts\``
    default:
      return `an unrecognized install shape at ${p.activeRoot || '(no entry path)'} — adopt the managed layout with \`mercury install\` for update support`
  }
}

async function installerRoad(
  installer: ForeignInstaller,
  options: UpdateCliOptions,
  roots: LayoutRoots,
  provenance: Record<string, unknown>,
): Promise<never> {
  const command = installer.updateCommand
  if (!options.yes) {
    if (options.json) {
      return failJson({
        mode: 'update',
        state: 'refused',
        stage: 'consent',
        reason: `this Mercury was installed by ${installer.name}; \`mercury update\` runs \`${command}\` after asking`,
        remedy: 'run `mercury update --yes` to run it without the question',
        provenance,
      })
    }
    const agreed = await askYesNo(installerConsentQuestion(installer))
    if (!agreed) {
      return cliError(`update not run — answer y to run \`${command}\`, or run \`mercury update --yes\`\nthe active installation was not changed`)
    }
  }
  if (!options.json) process.stderr.write(`running: ${command}\n`)
  const from = MACRO.VERSION
  const ran = await runInstallerUpgrade(installer, { stdoutTo: options.json ? 'stderr' : 'inherit' })
  if (ran.state === 'not-found') {
    if (options.json) return failJson({ mode: 'update', state: 'installer-missing', installer: installer.name, command, executable: ran.executable, provenance })
    return cliError(`update not run: \`${ran.executable}\` is not on PATH, so \`${command}\` cannot run here\nthe active installation was not changed`)
  }
  if (ran.state === 'failed') {
    if (options.json) return failJson({ mode: 'update', state: 'installer-failed', installer: installer.name, command, note: ran.note, provenance })
    return cliError(`update not completed: \`${command}\` could not run (${ran.note})`)
  }
  if (ran.exitCode !== 0) {
    if (options.json) return failJson({ mode: 'update', state: 'installer-failed', installer: installer.name, command, exitCode: ran.exitCode, provenance })
    return cliError(`update not completed: \`${command}\` exited ${ran.exitCode}\n  its own words are above; the installation is whatever ${installer.name} left`)
  }
  const after = readVersionAfterUpgrade(roots)
  if (options.json) {
    const record = {
      mode: 'update',
      state: 'installer-ran',
      installer: installer.name,
      command,
      exitCode: 0,
      from,
      to: after.state === 'read' ? after.version : null,
      commandOnPath: after.state === 'no-command' ? null : after.command,
      ...(after.state === 'unreadable' ? { note: after.note } : {}),
      provenance,
    }
    return after.state === 'read' ? emitJson(record) : failJson(record)
  }
  switch (after.state) {
    case 'read':
      return cliOk(
        after.version === from
          ? `Mercury is still ${from} after \`${command}\` — ${installer.name}'s package has not moved past it yet\n  the \`mercury\` your shell runs is ${after.command}`
          : `updated: ${from} → ${after.version} (${installer.name}: \`${command}\`)\n  the \`mercury\` your shell runs is ${after.command}`,
      )
    case 'no-command':
      return cliError(`\`${command}\` finished; no \`mercury\` is on your PATH to read the installed version from`)
    case 'unreadable':
      return cliError(`\`${command}\` finished; ${after.command} --version did not answer (${after.note})`)
  }
}

export async function update(options: UpdateCliOptions = {}): Promise<never> {
  const picked = [options.check, options.status, options.rollback].filter(Boolean).length
  if (picked > 1) {
    console.error('mercury update: --check, --status and --rollback are mutually exclusive')
    process.exit(2)
  }
  const roots = resolveLayoutRoots()
  const provenance = resolveInstallProvenance()
  const installer = foreignInstallerOf(provenance)
  const npmWrapper = provenance.kind === 'managed' ? npmWrapperOnPath(commandOnPath(roots)) : null
  const provenanceRecord = {
    kind: provenance.kind,
    activeRoot: provenance.activeRoot,
    updateOwner: provenance.updateOwner,
    updateCommand: installer?.updateCommand ?? null,
    npmWrapper,
  }
  const progress: Progress = options.json ? () => {} : progressToStderr

  const residue = readBootAttemptResidue()
  if (residue && residue.count >= 3) {
    console.error(`mercury update: warning — ${formatBootResidueWarning(residue)}`)
  }

  if (options.status) {
    const status = await channelStatus(roots)
    const pointerDamaged = status.installedPointer === 'unreadable'
    if (options.json) {
      return pointerDamaged
        ? failJson({ mode: 'status', ...status, provenance: provenanceRecord })
        : emitJson({ mode: 'status', ...status, provenance: provenanceRecord })
    }
    const installedLine =
      status.installedPointer === 'ok'
        ? status.installedVersion!
        : status.installedPointer === 'absent'
          ? '(no managed install)'
          : status.installedPointer === 'empty'
            ? '(pointer file empty — edit <versions>/current.txt to the active version)'
            : '(pointer file unreadable — fix permissions on <versions>/current.txt)'
    const lines = [
      `running version:   ${status.runningVersion}`,
      `this Mercury:      ${provenanceStatusWords(provenance, npmWrapper)}`,
      `installed version: ${installedLine}`,
      `previous version:  ${status.previousVersion ?? '(none)'}`,
      `versions present:  ${status.versionsPresent.join(', ') || '(none)'}`,
      `versions dir:      ${status.versionsDir}`,
      `stable command:    ${status.shimPath} (${status.shim})`,
      `runtime:           ${statusRuntimeLine(status)}`,
      `channel:           ${status.channelRepo} (GitHub releases — read anonymously, or through gh when it is signed in)`,
      `channel access:    ${status.access.state === 'ok' ? `ok (${describeChannelRoad(status.access.road)})` : `${status.access.state} — ${status.access.note}`}`,
    ]
    return pointerDamaged ? cliError(lines.join('\n')) : cliOk(lines.join('\n'))
  }

  if (options.rollback) {
    if (installer) {
      const reason = `this Mercury was installed by ${installer.name}; \`mercury update --rollback\` manages installs made by \`mercury install\` or the install script`
      const remedy = `${installer.name} manages this install's versions; ${installerRoadWords(installer)}`
      if (options.json) return failJson({ mode: 'rollback', state: 'refused', reason, remedy, provenance: provenanceRecord })
      return cliError(`rollback refused: ${reason}\n  ${remedy}`)
    }
    reconcileManagedShims(roots)
    const rolled = await performRollback(roots, progress)
    if (options.json) {
      return rolled.state === 'rolled-back' ? emitJson({ mode: 'rollback', ...rolled }) : failJson({ mode: 'rollback', ...rolled })
    }
    if (rolled.state === 'rolled-back') {
      return cliOk(
        `rolled back: ${rolled.from ?? '(unknown)'} → ${rolled.to}\nthe newer version stays under the versions directory for diagnosis; \`mercury update\` reinstalls it`,
      )
    }
    return cliError(`rollback refused: ${rolled.reason}\n  ${rolled.remedy}`)
  }

  if (options.check) {
    const check = await checkForUpdate(roots, progress)
    if (options.json) {
      const ok = check.state === 'update-available' || check.state === 'current' || check.state === 'no-releases'
      return ok
        ? emitJson({ mode: 'check', ...check, provenance: provenanceRecord })
        : failJson({ mode: 'check', ...check, provenance: provenanceRecord })
    }
    switch (check.state) {
      case 'update-available': {
        const next = installer
          ? `this Mercury was installed by ${installer.name}; ${installerRoadWords(installer)}`
          : `run \`mercury update\` to install it${npmWrapper === null ? '' : ` (${NPM_WRAPPER_ROAD_WORDS})`}`
        return cliOk(
          `update available: ${check.tag} (installed: ${check.installed})\n  asset: ${check.assetName}\n  channel: ${check.channelRepo} (${describeChannelRoad(check.road)})\n${next}`,
        )
      }
      case 'current':
        return cliOk(`Mercury is current: ${check.installed} (channel: ${check.channelRepo}, ${describeChannelRoad(check.road)})`)
      case 'no-releases':
        return cliOk(`no releases found on ${check.channelRepo} (${describeChannelRoad(check.road)}); installed: ${check.installed}`)
      case 'access-unavailable':
        return cliError(`update check unavailable: ${check.access.note}\n  ${check.access.remedy}`)
      case 'unsupported-platform':
        return cliError(`update check unavailable: ${check.note}`)
      case 'malformed-release':
        return cliError(`update check refused: ${check.note}`)
      case 'invalid-installed-version':
        return cliError(
          `installed version "${check.installed}" is not a channel version (v<major>.<minor>.<patch>-<label>.<n>) — this build cannot compare against the channel`,
        )
      case 'pointer-unreadable':
        return cliError(
          `update check refused: the current-version pointer is unreadable (${check.note})\n  fix permissions on <versions>/current.txt — Mercury never guesses through filesystem damage`,
        )
    }
  }

  if (installer) return installerRoad(installer, options, roots, provenanceRecord)
  const result = await performUpdate(roots, progress, { allowUnsigned: options.allowUnsigned })
  if (result.state === 'updated' || (result.state === 'no-update' && result.check.state === 'current')) {
    reconcileManagedShims(roots)
  }
  const shellCommand = result.state === 'updated' ? commandOnPath(roots) : null
  try {
    const { runLifecycleVerbOpportunity } = await import('../utils/backgroundHousekeeping.js')
    await runLifecycleVerbOpportunity('update')
  } catch {
  }
  if (options.json) {
    const ok =
      result.state === 'updated' ||
      (result.state === 'no-update' && (result.check.state === 'current' || result.check.state === 'no-releases'))
    const record = shellCommand ? { mode: 'update', ...result, commandOnPath: shellCommand } : { mode: 'update', ...result }
    return ok ? emitJson(record) : failJson(record)
  }
  switch (result.state) {
    case 'updated': {
      const shimLine =
        result.shim.state === 'refused-foreign'
          ? `\n  stable command NOT refreshed: ${result.shim.note}`
          : result.shim.state === 'written'
            ? `\n  stable command refreshed: ${result.shim.path}`
            : ''
      const shellLines = shellCommand ? commandOnPathWarning(roots, shellCommand, 'the updated one') : null
      const shellWords = shellLines ? `\n  ${shellLines[0]}\n  ${shellLines[1]}` : ''
      return cliOk(
        `updated: ${result.from} → ${result.to} (${describeChannelRoad(result.road)})\n  signature: ${result.signature}${result.unsignedOverride ? ' (accepted by explicit --allow-unsigned)' : ''}\n  previous version kept${result.previousKept ? '' : ' (none was installed)'} — \`mercury update --rollback\` returns to it${shimLine}${shellWords}`,
      )
    }
    case 'no-update':
      switch (result.check.state) {
        case 'current':
          return cliOk(`Mercury is current: ${result.check.installed} (channel: ${result.check.channelRepo}, ${describeChannelRoad(result.check.road)})`)
        case 'no-releases':
          return cliOk(`no releases found on ${result.check.channelRepo} (${describeChannelRoad(result.check.road)}); installed: ${result.check.installed}`)
        case 'access-unavailable':
          return cliError(`update unavailable: ${result.check.access.note}\n  ${result.check.access.remedy}`)
        case 'unsupported-platform':
          return cliError(`update unavailable: ${result.check.note}`)
        case 'malformed-release':
          return cliError(`update refused: ${result.check.note}`)
        case 'invalid-installed-version':
          return cliError(`installed version "${result.check.installed}" is not a channel version (v<major>.<minor>.<patch>-<label>.<n>)`)
        case 'pointer-unreadable':
          return cliError(
            `update refused: the current-version pointer is unreadable (${result.check.note})\n  fix permissions on <versions>/current.txt — Mercury never guesses through filesystem damage`,
          )
        default:
          return cliError('update did not run')
      }
    case 'refused': {
      const receiptLine = result.receiptPath ? `\n  receipt: ${result.receiptPath}` : ''
      const retryLine = result.retryable ? ' (retry is appropriate)' : ''
      return cliError(
        `update refused at ${result.stage}: ${result.reason}\n  ${result.remedy}${retryLine}${receiptLine}\nthe active installation was not changed`,
      )
    }
    case 'restored': {
      const receiptLine = result.receiptPath ? `\n  receipt: ${result.receiptPath}` : ''
      return cliError(
        `update failed at ${result.stage} and the previous version was restored automatically\n  reason: ${result.reason}\n  active version: ${result.activeVersion}${receiptLine}`,
      )
    }
  }
}
