// ============================================================================
//  src/cli/handlers/util.tsx — the `setup-token` leaf and the rich
//  health route. Both render into a caller-supplied Ink root.
// ============================================================================
import React, { Suspense } from 'react'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Crab, Wordmark } from '../../components/mercury-ui/assets.js'
import { MercuryHealthCertificate } from '../../commands/health/HealthCertificate.js'
import { MERCURY_VERSION } from '../../constants/product.js'
import { Box, Text, type Root } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'
import { isAnthropicAuthEnabled } from '../../utils/auth.js'
import { logError } from '../../utils/log.js'

/**
 * `mercury setup-token`: mint a long-lived OAuth token. The flow renders
 * inside the app-state and keybinding providers; exits 0 when done.
 */
export async function setupTokenHandler(root: Root): Promise<void> {
  // The warning shows exactly when first-party OAuth auth is NOT enabled —
  // credentials already come from the environment, an API-key helper, a
  // third-party provider, or bare mode.
  const showExistingCredentialWarning = !isAnthropicAuthEnabled()
  await new Promise<void>(resolve => {
    root.render(
      <AppStateProvider onChangeAppState={onChangeAppState}>
        <KeybindingSetup>
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Crab />
              <Wordmark version={MERCURY_VERSION} />
              <Text dimColor>Long-lived token setup</Text>
            </Box>
            {showExistingCredentialWarning ? (
              <Text color="yellow">
                This session already has credentials (via environment variable
                or API key helper). This flow mints a separate OAuth token you
                can use in their place.
              </Text>
            ) : null}
            <ConsoleOAuthFlow
              onDone={() => resolve()}
              startingMessage={
                'This creates a long-lived authentication token for your Claude account. The token is valid for one year and requires an active subscription.'
              }
            />
          </Box>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  root.unmount()
  process.exit(0)
}

/**
 * The rich health route: mounts the CANONICAL certificate view — the same
 * one the health slash command shows — lazily behind a suspense boundary
 * with no fallback. Nothing here may start MCP servers; the certificate's
 * MCP row reports from existing knowledge alone. The process exits 0
 * regardless of renderer failure.
 */
export async function healthHandler(root: Root): Promise<void> {
  try {
    await new Promise<void>(resolve => {
      root.render(
        <AppStateProvider onChangeAppState={onChangeAppState}>
          <KeybindingSetup>
            <Suspense>
              <MercuryHealthCertificate onClose={() => resolve()} />
            </Suspense>
          </KeybindingSetup>
        </AppStateProvider>,
      )
    })
  } catch (error) {
    logError(error)
  } finally {
    try {
      root.unmount()
    } catch (error) {
      logError(error)
    }
  }
  process.exit(0)
}
