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
              <Text color="ansi:yellow">
                This session already has credentials (via environment variable or API key helper). This flow mints a separate OAuth token you can use in their place.
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
