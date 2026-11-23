import { Suspense } from 'react'
import { ConsoleOAuthFlow } from '../../models/sign-in/flow-cards/SignInFlow.js'
import { Crab, Wordmark } from '../../screen/widgets/assets.js'
import { MercuryHealthCertificate } from '../health/HealthCertificate.js'
import { MERCURY_VERSION } from '../../platform/product/product.js'
import { Box, Text, type Root } from '../../screen/themedRenderer.js'
import { KeybindingSetup } from '../../screen/keys/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../screen/app-state/AppState.js'
import { isAnthropicAuthEnabled } from '../../models/sign-in/credentials/auth.js'
import { logError } from '../../platform/logs/errorLog.js'
export async function setupTokenHandler(root: Root): Promise<void> {
  const warningOwed = !isAnthropicAuthEnabled()
  await new Promise<void>(resolve => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Crab />
              <Wordmark version={MERCURY_VERSION} />
              <Text dimColor>Long-lived token setup</Text>
            </Box>
            {warningOwed && (
              <Text color="yellow">
                This session already has credentials (via environment variable
                or API key helper). This flow mints a separate OAuth token you
                can use in their place.
              </Text>
            )}
            <ConsoleOAuthFlow
              mode="setup-token"
              startingMessage="This creates a long-lived authentication token for your Claude account. The token is valid for one year and requires an active subscription."
              onDone={() => resolve()}
            />
          </Box>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  root.unmount()
  process.exit(0)
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
