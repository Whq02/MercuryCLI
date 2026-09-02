
import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getGlobalConfig } from '../utils/config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import {
  IDE_BRIDGE_SERVER_NAME,
  initializeIdeIntegration,
  isSupportedTerminal,
  type DetectedIDEInfo,
  type IDEExtensionInstallationStatus,
  type IdeType,
} from '../utils/ide.js'
import { logError } from '../utils/log.js'


function autoConnectFlagRaw(): string | undefined {
  return flagEnv('MERCURY_IDE_AUTO_CONNECT')
}

function advertisedIdePortPresent(): boolean {
  const raw = flagEnv('MERCURY_IDE_PORT')
  return raw !== undefined && raw.trim() !== ''
}

interface UseIDEIntegrationProps {
  autoConnectIdeFlag: boolean | undefined
  ideToInstallExtension: IdeType | null
  setDynamicMcpConfig: Dispatch<SetStateAction<Record<string, ScopedMcpServerConfig> | undefined>>
  setShowIdeOnboarding: Dispatch<SetStateAction<boolean>>
  setIDEInstallationState: Dispatch<SetStateAction<IDEExtensionInstallationStatus | null>>
}

export function useIDEIntegration({
  autoConnectIdeFlag,
  ideToInstallExtension,
  setDynamicMcpConfig,
  setShowIdeOnboarding,
  setIDEInstallationState,
}: UseIDEIntegrationProps): void {
  useEffect(() => {
    const onIdeDetected = (ide: DetectedIDEInfo | null): void => {
      if (ide === null) return

      const autoConnectRaw = autoConnectFlagRaw()
      if (isEnvDefinedFalsy(autoConnectRaw)) return
      const enabled =
        getGlobalConfig().autoConnectIde === true ||
        autoConnectIdeFlag === true ||
        isSupportedTerminal() ||
        advertisedIdePortPresent() ||
        ideToInstallExtension !== null ||
        isEnvTruthy(autoConnectRaw)
      if (!enabled) return

      setDynamicMcpConfig(prev => {
        if (prev?.[IDE_BRIDGE_SERVER_NAME] !== undefined) return prev
        return {
          ...prev,
          [IDE_BRIDGE_SERVER_NAME]: {
            type: ide.url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
            url: ide.url,
            ideName: ide.name,
            ...(ide.authToken !== undefined ? { authToken: ide.authToken } : {}),
            ...(ide.ideRunningInWindows !== undefined
              ? { ideRunningInWindows: ide.ideRunningInWindows }
              : {}),
            scope: 'dynamic',
          } as ScopedMcpServerConfig,
        }
      })
    }

    void initializeIdeIntegration(
      onIdeDetected,
      ideToInstallExtension,
      () => setShowIdeOnboarding(true),
      status => setIDEInstallationState(status),
    ).catch(logError)
  }, [
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState,
  ])
}
