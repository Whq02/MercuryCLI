import type { Command as CommanderCommand } from '@commander-js/extra-typings'
import { flagEnv } from '../../substrate/flagRegistry.js'
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function writeXaaIdpSettings(value: XaaIdpSettings | undefined): { error: Error | null } {
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
    .option('--client-secret', 'read the client secret from MERCURY_MCP_XAA_IDP_CLIENT_SECRET')
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
            secret = flagEnv('MERCURY_MCP_XAA_IDP_CLIENT_SECRET')
            if (!secret) {
              cliError('--client-secret requires the MERCURY_MCP_XAA_IDP_CLIENT_SECRET environment variable')
              return
            }
          }

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

          if (previous) {
            const keyChanged = issuerKey(previous.issuer) !== issuerKey(options.issuer)
            const clientChanged = previous.clientId !== options.clientId
            if (keyChanged) {
              clearIdpIdToken(previous.issuer)
              clearIdpClientSecret(previous.issuer)
            } else if (clientChanged) {
              clearIdpIdToken(options.issuer)
              clearIdpClientSecret(options.issuer)
            }
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
      const settings = getXaaIdpSettings()
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
