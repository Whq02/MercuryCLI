import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import {
  browserVersionOf,
  detectInstalledBrowsers,
  driverNodeGate,
  listManagedBrowsers,
  removeManagedBrowser,
  resolveBrowser,
} from '../../services/browser/browserResolver.js'
import { driverVersion } from '../../services/browser/browserSession.js'

// ============================================================================
// commands/browser/browserCommand.ts — the `/browser` verbs.
//
// install runs in TWO explicit steps so the operator consents to the exact
// bytes: `/browser install [<buildId>]` shows the planned build + disk cost
// and asks for `/browser install confirm`; only the confirm invocation
// downloads. The consent token is a PERSISTED plan file beside the cache
// (never module memory — plan and confirm may run in different processes,
// e.g. two headless -p invocations), and `/browser install <buildId>
// confirm` carries the token in the invocation itself. The downloaded build
// lands in the managed cache (config home) — never in release archives.
// remove deletes a named build.
// ============================================================================

function statusText(): string {
  const lines: string[] = []
  const gate = driverNodeGate()
  lines.push(`driver: puppeteer-core ${driverVersion()} (bundled)${gate.ok ? '' : ` — drive ops gated: ${gate.note}`}`)
  const r = resolveBrowser()
  if (r.state === 'ok') {
    const v = browserVersionOf(r.executablePath)
    lines.push(`resolves: ${r.source} — ${r.label}${v ? ` (${v})` : ''}`, `  ${r.executablePath}`)
  } else {
    lines.push(`resolves: UNAVAILABLE — ${r.note}`, ...r.remedies.map(x => `  remedy: ${x}`))
  }
  const installed = detectInstalledBrowsers()
  lines.push(installed.length ? `installed: ${installed.map(b => b.label).join(' · ')}` : 'installed: none found')
  const managed = listManagedBrowsers()
  lines.push(
    managed.length
      ? `managed cache: ${managed.map(m => `${m.buildId} (${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB)`).join(' · ')}`
      : 'managed cache: empty',
  )
  return lines.join('\n')
}

export const call = async (arg: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  const parts = arg.trim().split(/\s+/).filter(Boolean)
  const verb = parts[0] ?? 'status'

  if (verb === 'status' || verb === '') {
    return { type: 'text', value: statusText() }
  }

  if (verb === 'install') {
    const { installManagedBrowser, planBrowserInstall, persistInstallPlan, readPersistedInstallPlan, clearPersistedInstallPlan } =
      await import('../../services/browser/browserInstall.js')
    const rest = parts.slice(1)
    const confirming = rest.includes('confirm')
    const buildArg = rest.find(t => t !== 'confirm')
    if (buildArg !== undefined && !/^\d+(\.\d+)*$/.test(buildArg)) {
      // An unrecognized token must refuse by name, never be silently
      // swallowed into a plan for something else.
      return {
        type: 'text',
        value: `unrecognized install argument '${buildArg}' — usage: /browser install [<buildId>] [confirm]`,
      }
    }
    if (confirming) {
      let buildId = buildArg ?? null
      if (buildId === null) {
        const persisted = readPersistedInstallPlan()
        if (!persisted) {
          return { type: 'text', value: 'no install plan recorded — run /browser install first' }
        }
        if (persisted.expired) {
          clearPersistedInstallPlan()
          return { type: 'text', value: 'the recorded install plan EXPIRED (older than 10 minutes) — run /browser install again' }
        }
        buildId = persisted.buildId
      }
      clearPersistedInstallPlan()
      const result = await installManagedBrowser(buildId)
      return {
        type: 'text',
        value: `installed Chrome for Testing ${result.buildId} — ${(result.sizeBytes / 1024 / 1024).toFixed(0)} MB on disk\n  ${result.executablePath}\nremove any time: /browser remove ${result.buildId}`,
      }
    }
    const plan = await planBrowserInstall(buildArg)
    persistInstallPlan(plan.buildId)
    return {
      type: 'text',
      value: `install plan (nothing downloaded yet):\n  ${plan.consentLine}\nconfirm with: /browser install confirm  (or: /browser install ${plan.buildId} confirm)`,
    }
  }

  if (verb === 'remove') {
    const buildId = parts[1]
    if (!buildId) return { type: 'text', value: 'usage: /browser remove <buildId> (see /browser status)' }
    const removed = removeManagedBrowser(buildId)
    return { type: 'text', value: removed ? `removed Chrome for Testing ${buildId}` : `no managed build '${buildId}'` }
  }

  return { type: 'text', value: `unknown verb '${verb}' — usage: /browser [status | install [<buildId>] [confirm] | remove <buildId>]` }
}
