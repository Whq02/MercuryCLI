import type { Command as CommanderCommand } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import {
  acquireIdpIdToken,
  clearIdpClientSecret,
  clearIdpIdToken,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  issuerKey,
  saveIdpClientSecret,
  saveIdpIdTokenFromJwt,
  type XaaIdpSettings,
} from '../../services/mcp/xaaIdpLogin.js'
import { binaryName } from '../../utils/config/derived.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

/** Loopback hosts that may use plain http (conformance harnesses only). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The `xaaIdp` settings member is env-gated out of the generated settings
 * type; writes reach it through the same single sanctioned cast the reader
 * uses.
 */
function writeXaaIdpSettings(value: XaaIdpSettings | undefined): { error: Error | null } {
  // The port key is written EXPLICITLY even when undefined: the settings
  // writer merges recursively and removes a key only when it is present
  // with an undefined value — omitting it would silently retain a fixed
  // port configured for a previous IdP.
  return updateSettingsForSource('userSettings', { xaaIdp: value } as Partial<SettingsJson>)
}

export function registerMcpXaaIdpCommand(mcp: CommanderCommand): void {
  const cli = binaryName()
  const xaa = mcp
    .command('xaa')
    .description('Manage the user-level cross-app-access IdP connection')

  xaa
    .command('setup')
    .description('Configure the IdP all XAA-enabled servers reuse')
    .requiredOption('--issuer <url>', 'the IdP issuer URL')
    .requiredOption('--client-id <id>', 'the OAuth client id registered with the IdP')
    .option('--client-secret', 'read the client secret from MCP_XAA_IDP_CLIENT_SECRET')
    .option(
      '--callback-port <port>',
      'fixed loopback callback port (only when the IdP does not honour port-any matching)',
    )
    .action(
      (options: {
        issuer: string
        clientId: string
        clientSecret?: boolean
        callbackPort?: string
      }) => {
        void (async () => {
          // EVERYTHING validates before ANY write: two stores are written in
          // sequence, and an error exit between them would leave a
          // configuration naming an IdP whose secret is absent. The URL and
          // port checks also protect the whole user-settings file — the
          // settings writer does not validate, the next start's READER does,
          // and one bad field makes it discard the entire file.
          let parsed: URL
          try {
            parsed = new URL(options.issuer)
          } catch {
            cliError(`--issuer is not a valid URL: ${options.issuer}`)
            return
          }
          if (parsed.protocol !== 'https:') {
            const loopback =
              parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname === '::1' ? '[::1]' : parsed.hostname)
            if (!loopback) {
              cliError(
                `--issuer must be https: (got ${parsed.protocol}//${parsed.host}) — plain http would leak the client secret and the authorization code; it is allowed only for loopback hosts (localhost, 127.0.0.1, [::1])`,
              )
              return
            }
          }
          let callbackPort: number | undefined
          if (options.callbackPort !== undefined) {
            callbackPort = parseInt(options.callbackPort, 10)
            if (!Number.isInteger(callbackPort) || callbackPort <= 0) {
              cliError(`--callback-port must be a positive integer (got ${options.callbackPort})`)
              return
            }
          }
          let secret: string | undefined
          if (options.clientSecret) {
            secret = process.env.MCP_XAA_IDP_CLIENT_SECRET
            if (!secret) {
              cliError('--client-secret requires the MCP_XAA_IDP_CLIENT_SECRET environment variable')
              return
            }
          }

          // The clear path cannot recover these afterwards.
          const previous = getXaaIdpSettings()

          const { error } = writeXaaIdpSettings({
            issuer: options.issuer,
            clientId: options.clientId,
            callbackPort,
          } as XaaIdpSettings)
          if (error) {
            cliError(`Failed to write settings: ${error.message}`)
            return
          }

          // Keychain hygiene only AFTER the settings write succeeded — the
          // other way round, a failed write would leave the old
          // configuration in force with its secret already destroyed.
          if (previous) {
            const keyChanged = issuerKey(previous.issuer) !== issuerKey(options.issuer)
            const clientChanged = previous.clientId !== options.clientId
            if (keyChanged) {
              // The old slots are dead under the new configuration.
              clearIdpIdToken(previous.issuer)
              clearIdpClientSecret(previous.issuer)
            } else if (clientChanged) {
              // Same slot, new client registration: the cached token's
              // audience and the stored secret both belong to the OLD
              // client — useless, and misleading at login time.
              clearIdpIdToken(options.issuer)
              clearIdpClientSecret(options.issuer)
            }
            // Unchanged issuer AND client id: keep both, so re-running setup
            // merely to change the port never demands the secret again.
          }

          if (secret !== undefined) {
            const saved = saveIdpClientSecret(options.issuer, secret)
            if (!saved.success) {
              cliError(
                `Settings were written, but saving the client secret to the keychain failed${saved.warning ? ` (${saved.warning})` : ''}. Re-run with --client-secret once the keychain is available.`,
              )
              return
            }
          }
          cliOk(`XAA IdP configured: ${options.issuer}`)
        })()
      },
    )

  xaa
    .command('login')
    .description('Sign in to the configured IdP')
    .option('--force', 'ignore any cached token and log in again')
    .option('--id-token <jwt>', 'store a pre-obtained id_token directly (conformance harnesses)')
    .action((options: { force?: boolean; idToken?: string }) => {
      void (async () => {
        const settings = getXaaIdpSettings()
        if (!settings) {
          cliError(`No XAA IdP is configured — run \`${cli} mcp xaa setup\` first.`)
          return
        }
        if (options.idToken) {
          // Deliberately no issuer flag on this verb: the token can only be
          // filed under the configured issuer.
          const expiresAt = saveIdpIdTokenFromJwt(settings.issuer, options.idToken)
          cliOk(
            `Stored id_token for ${settings.issuer} (expires ${new Date(expiresAt).toISOString()})`,
          )
          return
        }
        if (options.force) {
          clearIdpIdToken(settings.issuer)
        }
        const cached = getCachedIdpIdToken(settings.issuer)
        if (cached !== undefined) {
          cliOk(`A valid id_token is already cached for ${settings.issuer}. Use --force to log in again.`)
          return
        }
        process.stdout.write(`Opening your browser to sign in with ${settings.issuer}…\n`)
        try {
          await acquireIdpIdToken({
            idpIssuer: settings.issuer,
            idpClientId: settings.clientId,
            idpClientSecret: getIdpClientSecret(settings.issuer),
            callbackPort: settings.callbackPort,
            onAuthorizationUrl: url => {
              process.stdout.write(`If the browser did not open, visit:\n${url}\n`)
            },
          })
          cliOk('IdP login complete — XAA servers will now authenticate silently.')
        } catch (error) {
          cliError(`IdP login failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    })

  xaa
    .command('show')
    .description('Show the configured IdP connection')
    .action(() => {
      const settings = getXaaIdpSettings()
      if (!settings) {
        cliOk('No XAA IdP is configured.')
        return
      }
      const lines = [
        `Issuer:        ${settings.issuer}`,
        `Client id:     ${settings.clientId}`,
        ...(settings.callbackPort !== undefined
          ? [`Callback port: ${settings.callbackPort}`]
          : []),
        `Client secret: ${
          getIdpClientSecret(settings.issuer) !== undefined
            ? 'stored in keychain'
            : 'not set — PKCE-only'
        }`,
        `Token:         ${
          getCachedIdpIdToken(settings.issuer) !== undefined
            ? 'yes (id_token cached)'
            : `no — run \`${cli} mcp xaa login\``
        }`,
      ]
      cliOk(lines.join('\n'))
    })

  xaa
    .command('clear')
    .description('Remove the IdP configuration, cached token and stored secret')
    .action(() => {
      // Read FIRST so the right keychain slots can be cleared afterwards.
      const settings = getXaaIdpSettings()
      // The merge treats an absent key as "no change" — removal is an
      // explicit undefined.
      const { error } = writeXaaIdpSettings(undefined)
      if (error) {
        cliError(`Failed to write settings: ${error.message}`)
        return
      }
      if (settings) {
        clearIdpIdToken(settings.issuer)
        clearIdpClientSecret(settings.issuer)
      }
      cliOk('XAA IdP configuration cleared.')
    })
}
