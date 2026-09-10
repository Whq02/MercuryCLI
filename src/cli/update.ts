import { reconcileManagedShims, resolveLayoutRoots } from 'src/services/privateChannel/installLayout.js'
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
  json?: boolean
}

const progressToStderr: Progress = (state, detail) => {
  console.error(detail ? `${state}: ${detail}` : state)
}

const emitJson = (value: unknown): never => cliOk(jsonStringify(value, null, 1) ?? '{}')
const failJson = (value: unknown): never => cliError(jsonStringify(value, null, 1) ?? '{}')

export async function update(options: UpdateCliOptions = {}): Promise<never> {
  const picked = [options.check, options.status, options.rollback].filter(Boolean).length
  if (picked > 1) {
    console.error('mercury update: --check, --status and --rollback are mutually exclusive')
    process.exit(2)
  }
  const roots = resolveLayoutRoots()
  const progress: Progress = options.json ? () => {} : progressToStderr

  const residue = readBootAttemptResidue()
  if (residue && residue.count >= 3) {
    console.error(`mercury update: warning — ${formatBootResidueWarning(residue)}`)
  }

  if (options.status) {
    const status = await channelStatus(roots)
    const pointerDamaged = status.installedPointer === 'unreadable'
    if (options.json) {
      return pointerDamaged ? failJson({ mode: 'status', ...status }) : emitJson({ mode: 'status', ...status })
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
      return ok ? emitJson({ mode: 'check', ...check }) : failJson({ mode: 'check', ...check })
    }
    switch (check.state) {
      case 'update-available':
        return cliOk(
          `update available: ${check.tag} (installed: ${check.installed})\n  asset: ${check.assetName}\n  channel: ${check.channelRepo} (${describeChannelRoad(check.road)})\nrun \`mercury update\` to install it`,
        )
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

  const result = await performUpdate(roots, progress, { allowUnsigned: options.allowUnsigned })
  if (result.state === 'updated' || (result.state === 'no-update' && result.check.state === 'current')) {
    reconcileManagedShims(roots)
  }
  try {
    const { runLifecycleVerbOpportunity } = await import('../utils/backgroundHousekeeping.js')
    await runLifecycleVerbOpportunity('update')
  } catch {
  }
  if (options.json) {
    const ok =
      result.state === 'updated' ||
      (result.state === 'no-update' && (result.check.state === 'current' || result.check.state === 'no-releases'))
    return ok ? emitJson({ mode: 'update', ...result }) : failJson({ mode: 'update', ...result })
  }
  switch (result.state) {
    case 'updated': {
      const shimLine =
        result.shim.state === 'refused-foreign'
          ? `\n  stable command NOT refreshed: ${result.shim.note}`
          : result.shim.state === 'written'
            ? `\n  stable command refreshed: ${result.shim.path}`
            : ''
      return cliOk(
        `updated: ${result.from} → ${result.to} (${describeChannelRoad(result.road)})\n  signature: ${result.signature}${result.unsignedOverride ? ' (accepted by explicit --allow-unsigned)' : ''}\n  previous version kept${result.previousKept ? '' : ' (none was installed)'} — \`mercury update --rollback\` returns to it${shimLine}`,
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
