// ============================================================================
//  src/entrypoints/init.ts — memoized one-time process initialization:
//  configuration, environment, network transport and cleanup registration
//  before the product runs.
// ============================================================================
import { memoize } from 'lodash-es'
// Bare side-effect imports: force-evaluate the bootstrap-state and config
// modules when THIS module loads rather than lazily inside init() — other
// modules capture module-evaluation order at import time.
import '../bootstrap/state.js'
import '../utils/config.js'
import { enableConfigs } from '../utils/config.js'
import { findMostRecentBackup } from '../utils/config/globalConfig.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { setupGracefulShutdown, gracefulShutdownSync } from '../utils/gracefulShutdown.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { recordFirstStartTime } from '../utils/config/derived.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import { configureGlobalAgents } from '../utils/proxy.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'
import { applyConfigEnvironmentVariables, applySafeConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { ensureLocalSettingsSchema } from '../utils/settings/localSchema.js'
import { getGithubRepo } from '../utils/git.js'
import { restoreGatewayAuth } from '../utils/gatewayTrust.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import {
  initializeRemoteManagedSettingsLoadingPromise,
  isEligibleForRemoteManagedSettings,
} from '../services/remoteManagedSettings/index.js'
import {
  initializePolicyLimitsLoadingPromise,
  isPolicyLimitsEligible,
} from '../services/policyLimits/index.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { ensureScratchpadDir, isScratchpadEnabled } from '../utils/permissions/filesystem.js'
import { ConfigParseError, ConfigReadError } from '../utils/errors.js'
import { logForDebugging } from '../utils/debug.js'
import { isSessionMarkedNonInteractive } from '../utils/cockpit/runtimePosture.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'

/**
 * A memoized async initializer — every call after the first returns the
 * same promise. Fire-and-forget steps stay unawaited: awaiting them would
 * turn optional warmups into boot dependencies.
 */
export const init: () => Promise<void> = memoize(async (): Promise<void> => {
  profileCheckpoint('init_function_start')
  try {
    // Interior checkpoints (marks only, not phases): the init window costs
    // ~130-146ms/boot in two coarse halves around settings_merge_start, and
    // attribution below this granularity was impossible with one interior
    // mark. Keep these out of PHASE_DEFINITIONS.
    // Configuration first — everything below reads through it.
    enableConfigs()
    profileCheckpoint('init_configs_enabled')

    // Only the SAFE env subset from settings; the full set applies after
    // trust is established.
    applySafeConfigEnvironmentVariables()
    // When trust ALREADY stands (a previously-trusted project), the FULL
    // merged env applies here too — the interactive road applied it
    // post-dialog but the headless/doctor road never did, so a project env
    // key outside the SAFE allowlist silently never landed while the USER
    // layer's same key (applied wholesale above) did: the cascade inverted
    // (FC-029). An untrusted workspace stays SAFE-only.
    try {
      const { checkHasTrustDialogAccepted } = await import('../utils/config/trust.js')
      if (checkHasTrustDialogAccepted()) applyConfigEnvironmentVariables()
    } catch (error) {
      logForDebugging(`init: trusted env application skipped: ${String(error)}`)
    }
    profileCheckpoint('init_safe_env_applied')

    // CA certificates BEFORE any TLS connection — the runtime caches its
    // certificate store at boot.
    applyExtraCACertsFromConfig()
    profileCheckpoint('init_ca_certs_applied')

    setupGracefulShutdown()
    profileCheckpoint('init_shutdown_installed')

    // Fire-and-forget: an extension login may not have populated the
    // account info.
    void populateOAuthAccountInfoIfNeeded().catch((error: unknown) =>
      logForDebugging(`init: oauth account populate failed: ${String(error)}`),
    )

    // Fire-and-forget, dormant: nothing writes a gateway session today, so
    // it returns immediately — wired so the day one exists it is
    // re-verified against its pinned TLS fingerprint before use. Never
    // throws, never touches the direct auth path.
    void restoreGatewayAuth().catch(() => {})

    // Fire-and-forget cache primers.
    void initJetBrainsDetection().catch(() => {})
    void getGithubRepo().catch(() => {})

    // Off the boot path: refresh the config home's generated settings
    // schema so editors validate settings files against THIS build's.
    setImmediate(() => {
      try {
        ensureLocalSettingsSchema()
      } catch {
        /* an affordance, never a boot failure */
      }
    })

    // The loading promises are created EARLY so other systems (extension
    // hooks) can await them; they carry timeouts so a never-called loader
    // cannot deadlock.
    if (isEligibleForRemoteManagedSettings()) {
      initializeRemoteManagedSettingsLoadingPromise()
    }
    if (isPolicyLimitsEligible()) {
      initializePolicyLimitsLoadingPromise()
    }

    recordFirstStartTime()
    profileCheckpoint('init_background_dispatch_done')

    configureGlobalMTLS()
    profileCheckpoint('init_mtls_configured')
    configureGlobalAgents()
    profileCheckpoint('init_agents_configured')

    // The API warm-up (utils/apiPreconnect) is dispatched by the root
    // action's preAction arm in main.tsx, after this init returns — CA certs
    // and agents are configured by then, and only the boots that make a
    // model request pay for (and wait on) the handshake. A headless
    // subcommand's loop ends the moment its own work does.

    setShellIfWindows()

    // Initialization itself happens later (after extension folders are
    // processed); only the shutdown is registered here.
    registerCleanup(() => shutdownLspServerManager())

    // Lazy: most sessions never create a team, and subagent-created teams
    // would otherwise sit on disk forever.
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import('../utils/swarm/teamHelpers.js')
      await cleanupSessionTeams()
    })

    if (isScratchpadEnabled()) {
      await ensureScratchpadDir()
    }
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigReadError) {
      // The file exists but could not be read (a permission refusal, a
      // sharing violation from a scanner or backup holding it, an io
      // error). Starting on defaults would paint a returning run as a
      // first run and let the first save overwrite the state the read
      // could not see — and the reset dialog's remedy IS that overwrite.
      // Refuse by name, on both postures, and stand down.
      process.stderr.write(
        `Mercury cannot read its configuration file at ${error.filePath} (${error.code}).\n` +
          `The file exists, so Mercury will not start on defaults: that would overwrite your saved account,\n` +
          `projects and trust grants on the next save. Make the file readable — fix its permissions, or close\n` +
          `the program holding it open — then start Mercury again.\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    if (error instanceof ConfigParseError) {
      // Non-interactive: the interactive dialog corrupts JSON consumers.
      if (isSessionMarkedNonInteractive()) {
        // The same pointer the interactive gate paints (FN-015 rank 65):
        // the newest good copy and the one command that restores it.
        let backupPath: string | null = null
        try {
          backupPath = findMostRecentBackup(error.filePath)
        } catch {
          backupPath = null
        }
        process.stderr.write(
          `Configuration error in ${(error as { filePath?: string }).filePath ?? 'settings'}: ${error.message}\n` +
            (backupPath !== null
              ? `A backup file exists at: ${backupPath}\nYou can restore it by running: cp "${backupPath}" "${error.filePath}"\n`
              : ''),
        )
        gracefulShutdownSync(1)
        return
      }
      const { showInvalidConfigDialog } = await import('../components/InvalidConfigDialog.js')
      return showInvalidConfigDialog({ error })
    }
    throw error
  }
})
