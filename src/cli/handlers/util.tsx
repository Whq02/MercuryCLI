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
  await new Promise<void>(resolve => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <Box flexDirection="column" gap={1} paddingY={1}>
            <Box gap={1}>
              <Crab />
              <Wordmark version={MERCURY_VERSION} />
              <Text dimColor>Long-lived token setup</Text>
            </Box>
            {!isAnthropicAuthEnabled() && (
              <Text color="ansi:yellow">
                Warning: Existing environment or credential helper authentication is active and may take precedence over this token.
              </Text>
            )}
            <ConsoleOAuthFlow
              mode="setup-token"
              startingMessage="Create a long-lived authentication token (valid for 1 year). Requires an active Anthropic subscription."
              onDone={() => resolve()}
            />
          </Box>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  try {
    root.unmount()
  } catch (error) {
    logError(error)
  }
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
