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

export async function checkManagedSettingsSecurity(
  cached: SettingsJson | null,
  incoming: SettingsJson,
): Promise<SecurityCheckResult> {
  if (!hasDangerousSettings(extractDangerousSettings(incoming))) return 'no_check_needed'
  if (!hasDangerousSettingsChanged(cached, incoming)) return 'no_check_needed'
  if (getIsNonInteractiveSession()) return 'no_check_needed'

  let settle: (result: SecurityCheckResult) => void = () => {}
  const decision = new Promise<SecurityCheckResult>(resolvePromise => {
    settle = resolvePromise
  })
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

export function handleSecurityCheckResult(result: SecurityCheckResult): boolean {
  if (result === 'rejected') {
    gracefulShutdownSync(1)
    return false
  }
  return true
}
