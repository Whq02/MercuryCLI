import { Suspense } from 'react'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Crab, Wordmark } from '../../components/mercury-ui/assets.js'
import { MercuryHealthCertificate } from '../../commands/health/HealthCertificate.js'
import { MERCURY_VERSION } from '../../constants/product.js'
import { Box, Text, type Root } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { isAnthropicAuthEnabled } from '../../utils/auth.js'
import { logError } from '../../utils/log.js'
import { notBuilt } from '../../pi/holes.js'

export async function setupTokenHandler(root: Root): Promise<void> {
  return notBuilt('src/cli/handlers/util.tsx:12')
}

export async function healthHandler(root: Root): Promise<void> {
  let failed = false
  try {
    await new Promise<void>(resolve => {
      root.render(
        <AppStateProvider>
          <KeybindingSetup>
            <Suspense>
              <MercuryHealthCertificate onClose={() => resolve()} />
            </Suspense>
          </KeybindingSetup>
        </AppStateProvider>,
      )
    })
  } catch (error) {
    failed = true
    logError(error)
  } finally {
    try {
      root.unmount()
    } catch (error) {
      logError(error)
    }
  }
  process.exit(failed ? 1 : 0)
}
