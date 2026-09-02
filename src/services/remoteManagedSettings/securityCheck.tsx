/**
 * The blocking approval gate shown when incoming remote policy adds or
 * changes DANGEROUS settings (shell-executing settings, non-allowlisted
 * environment variables, hook definitions — the extraction rules are owned
 * by the dialog component).
 */
import * as React from 'react'

import { ManagedSettingsSecurityDialog } from '../../components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.js'
import {
  extractDangerousSettings,
  hasDangerousSettings,
  hasDangerousSettingsChanged,
} from '../../components/ManagedSettingsSecurityDialog/utils.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'
import type { SettingsJson } from '../../utils/settings/types.js'

export type SecurityCheckResult = 'approved' | 'rejected' | 'no_check_needed'

/**
 * Inspect the incoming document and, when a dangerous delta exists in an
 * interactive session, render the blocking full-screen approval dialog and
 * await the operator's decision. The renderer is unmounted on either answer.
 */
export async function checkManagedSettingsSecurity(
  cached: SettingsJson | null,
  incoming: SettingsJson,
): Promise<SecurityCheckResult> {
  if (!hasDangerousSettings(extractDangerousSettings(incoming))) return 'no_check_needed'
  // Dangerous settings unchanged relative to the cached document ⇒ no check.
  if (!hasDangerousSettingsChanged(cached, incoming)) return 'no_check_needed'
  // Consistent with the workspace-trust dialog: no prompt without a human.
  if (getIsNonInteractiveSession()) return 'no_check_needed'

  let settle: (result: SecurityCheckResult) => void = () => {}
  const decision = new Promise<SecurityCheckResult>(resolvePromise => {
    settle = resolvePromise
  })
  // The dialog's Select confirm/cancel/arrow keys and the "no" quick key are
  // provider-scoped keybinding hooks: rendered bare they are inert, so the
  // dialog is wrapped in the app-state and keybinding-setup providers, with
  // the base render options (exit-on-ctrl-C false).
  const instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <ManagedSettingsSecurityDialog
          settings={incoming}
          onAccept={() => settle('approved')}
          onReject={() => settle('rejected')}
        />
      </KeybindingSetup>
    </AppStateProvider>,
    getBaseRenderOptions(false),
  )
  const result = await decision
  instance.unmount()
  return result
}

/**
 * Rejection triggers an immediate graceful shutdown with exit code 1 and
 * signals "do not continue"; approval and no-check-needed both continue.
 */
export function handleSecurityCheckResult(result: SecurityCheckResult): boolean {
  if (result === 'rejected') {
    gracefulShutdownSync(1)
    return false
  }
  return true
}
