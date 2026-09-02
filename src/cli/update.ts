// ============================================================================
//  src/cli/update.ts — `mercury update` over the PRIVATE release channel
//
//
//  Contract (the CLI design system): stdout carries the result, stderr the
//  progress/diagnostics; exit 0 = success incl. "already current", exit 1 =
//  operational failure, exit 2 = usage. `--json` emits one complete machine
//  object (frozen field names) and JSON errors on the same channel. No
//  npm/GCS auto-update machinery exists — this updater speaks ONLY to
//  the private GitHub repository through the collaborator's own signed-in gh.
// ============================================================================
import { reconcileManagedShims, resolveLayoutRoots } from 'src/services/privateChannel/installLayout.js'
import {
  channelStatus,
  checkForUpdate,
  performRollback,
  performUpdate,
  type Progress,
} from 'src/services/privateChannel/updateService.js'
import { formatBootResidueWarning, readBootAttemptResidue } from 'src/substrate/bootBeacon.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { cliError, cliOk } from './exit.js'

export interface UpdateCliOptions {
  check?: boolean
  status?: boolean
  rollback?: boolean
  json?: boolean
}

const progressToStderr: Progress = (state, detail) => {
  // biome-ignore lint/suspicious/noConsole: CLI progress belongs on stderr
  console.error(detail ? `${state}: ${detail}` : state)
}

const emitJson = (value: unknown): never => cliOk(jsonStringify(value, null, 1) ?? '{}')
const failJson = (value: unknown): never => cliError(jsonStringify(value, null, 1) ?? '{}')

export async function update(options: UpdateCliOptions = {}): Promise<never> {
  const picked = [options.check, options.status, options.rollback].filter(Boolean).length
  if (picked > 1) {
    // biome-ignore lint/suspicious/noConsole: usage error belongs on stderr
    console.error('mercury update: --check, --status and --rollback are mutually exclusive')
    process.exit(2)
  }
  const roots = resolveLayoutRoots()
  const progress: Progress = options.json ? () => {} : progressToStderr

  // /REC-4: a bricked interactive boot self-announces at the next verb.
  // Residue = enter-screen handoffs with no completed startup after them —
  // the 1.5.4 field shape (batch abort, exit 0, zero product writes) was
  // invisible until the operator diagnosed it by hand. stderr only: the
  // stdout/--json result contract stays frozen.
  // ≥3: two attempts can be one impatient double-^C during the node boot
  // window; a genuinely bricked launcher accrues a
  // third within seconds of the operator retrying.
  const residue = readBootAttemptResidue()
  if (residue && residue.count >= 3) {
    // biome-ignore lint/suspicious/noConsole: diagnostics belong on stderr
    console.error(`mercury update: warning — ${formatBootResidueWarning(residue)}`)
  }

  if (options.status) {
    const status = await channelStatus(roots)
    // FC-121: an unreadable pointer is the same filesystem damage --check
    // exits 1 for — two read-only verbs must not give opposite verdicts on
    // one state. The full report still prints; the exit code carries the
    // verdict, on the failure channel per the exit-helper discipline.
    const pointerDamaged = status.installedPointer === 'unreadable'
    if (options.json) {
      return pointerDamaged ? failJson({ mode: 'status', ...status }) : emitJson({ mode: 'status', ...status })
    }
    // UPD-11: the pointer's tri-state is named — absent, empty and unreadable
    // are different situations with different recoveries.
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
      `channel:           ${status.channelRepo} (private GitHub releases via your own gh sign-in)`,
      `channel access:    ${status.access.state === 'ok' ? 'ok' : `${status.access.state} — ${status.access.note}`}`,
    ]
    return pointerDamaged ? cliError(lines.join('\n')) : cliOk(lines.join('\n'))
  }

  if (options.rollback) {
    // THIS runtime knows its full launcher-set member list (the
    // update flow publishes with the PREVIOUS version's code, so members
    // added in a release — the win32 git-bash facade — never reached updated
    // installs). The two MUTATING verbs (rollback here, the bare update
    // below) are the ONLY heal sites; --check/--status stay read-only as
    // UPDATING.md promises, and `install --uninstall` never heals — nothing
    // can re-create a launcher behind a running uninstall.
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
          `update available: ${check.tag} (installed: ${check.installed})\n  asset: ${check.assetName}\n  channel: ${check.channelRepo}\nrun \`mercury update\` to install it`,
        )
      case 'current':
        return cliOk(`Mercury is current: ${check.installed} (channel: ${check.channelRepo})`)
      case 'no-releases':
        return cliOk(`no private releases found on ${check.channelRepo}; installed: ${check.installed}`)
      case 'access-unavailable':
        return cliError(`update check unavailable: ${check.access.note}\n  ${check.access.remedy}`)
      case 'unsupported-platform':
        return cliError(`update check unavailable: ${check.note}`)
      case 'malformed-release':
        return cliError(`update check refused: ${check.note}`)
      case 'invalid-installed-version':
        return cliError(
          `installed version "${check.installed}" is not a private-channel version — this build cannot compare against the channel`,
        )
      case 'pointer-unreadable':
        return cliError(
          `update check refused: the current-version pointer is unreadable (${check.note})\n  fix permissions on <versions>/current.txt — Mercury never guesses through filesystem damage`,
        )
    }
  }

  // the bare-update verb self-heals the
  // launcher set before the transaction (post-activation writeShim then
  // publishes the NEW version's set).
  reconcileManagedShims(roots)
  const result = await performUpdate(roots, progress)
  // cleanup rides the update verb too (bounded, sentinel-gated) — the
  // audit's home showed `.last-cleanup` starved for days once interactive
  // boots stopped succeeding while `mercury update` still ran fine.
  try {
    const { runLifecycleVerbOpportunity } = await import('../utils/backgroundHousekeeping.js')
    await runLifecycleVerbOpportunity('update')
  } catch {
    /* the update outcome stands regardless */
  }
  if (options.json) {
    const ok =
      result.state === 'updated' ||
      (result.state === 'no-update' && (result.check.state === 'current' || result.check.state === 'no-releases'))
    return ok ? emitJson({ mode: 'update', ...result }) : failJson({ mode: 'update', ...result })
  }
  switch (result.state) {
    case 'updated': {
      // D-2: the shim refresh is part of the update — a refusal is a named
      // line the operator can act on, never a silently swallowed outcome.
      const shimLine =
        result.shim.state === 'refused-foreign'
          ? `\n  stable command NOT refreshed: ${result.shim.note}`
          : result.shim.state === 'written'
            ? `\n  stable command refreshed: ${result.shim.path}`
            : ''
      return cliOk(
        `updated: ${result.from} → ${result.to}\n  previous version kept${result.previousKept ? '' : ' (none was installed)'} — \`mercury update --rollback\` returns to it${shimLine}`,
      )
    }
    case 'no-update':
      switch (result.check.state) {
        case 'current':
          return cliOk(`Mercury is current: ${result.check.installed} (channel: ${result.check.channelRepo})`)
        case 'no-releases':
          return cliOk(`no private releases found on ${result.check.channelRepo}; installed: ${result.check.installed}`)
        case 'access-unavailable':
          return cliError(`update unavailable: ${result.check.access.note}\n  ${result.check.access.remedy}`)
        case 'unsupported-platform':
          return cliError(`update unavailable: ${result.check.note}`)
        case 'malformed-release':
          return cliError(`update refused: ${result.check.note}`)
        case 'invalid-installed-version':
          return cliError(`installed version "${result.check.installed}" is not a private-channel version`)
        case 'pointer-unreadable':
          return cliError(
            `update refused: the current-version pointer is unreadable (${result.check.note})\n  fix permissions on <versions>/current.txt — Mercury never guesses through filesystem damage`,
          )
        default:
          return cliError('update did not run')
      }
    case 'refused': {
      // The refusal names its stage, whether retry helps, and where the local
      // receipt lives — calm, one fact per line.
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
