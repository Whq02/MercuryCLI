import { Option, type Command as CommanderCommand } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import { addMcpConfig } from '../../services/mcp/config.js'
import { readClientSecret, saveMcpClientSecret } from '../../services/mcp/auth.js'
import type { McpServerConfig } from '../../services/mcp/types.js'
import {
  describeMcpConfigFilePath,
  ensureConfigScope,
  ensureTransport,
  parseHeaders,
} from '../../services/mcp/utils.js'
import { getXaaIdpSettings, isXaaEnabled } from '../../services/mcp/xaaIdpLogin.js'
import { binaryName } from '../../utils/config/derived.js'
import { describeHeadersRedacted } from '../../utils/redactHeaders.js'

/**
 * A command that was probably meant as a URL (contract data — the five
 * shapes the warning keys on).
 */
function looksLikeUrl(command: string): boolean {
  return (
    command.startsWith('http://') ||
    command.startsWith('https://') ||
    command.startsWith('localhost') ||
    command.endsWith('/sse') ||
    command.endsWith('/mcp')
  )
}

/** `KEY=VALUE` assignments for stdio servers; anything else throws. */
function parseEnvAssignments(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) {
      throw new Error(`Invalid environment variable "${pair}" — expected KEY=VALUE`)
    }
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

export function registerMcpAddCommand(mcp: CommanderCommand): void {
  const cli = binaryName()
  mcp
    .command('add')
    .description('Add an MCP server')
    .argument('[name]', 'server name')
    .argument('[commandOrUrl]', 'the command to launch it, or its URL')
    .argument('[args...]', 'stdio subprocess arguments')
    .option('-s, --scope <scope>', 'configuration scope (local, user, or project)', 'local')
    .option('-t, --transport <transport>', 'transport type (stdio, sse, http)')
    .option('-e, --env <env...>', 'environment variables for a stdio server (KEY=VALUE)')
    .option('-H, --header <header...>', 'HTTP headers for an SSE/HTTP server')
    .option('--client-id <clientId>', 'OAuth client id')
    .option('--client-secret', 'read the OAuth client secret (prompt, or MCP_CLIENT_SECRET)')
    .option('--callback-port <port>', 'fixed OAuth callback port')
    .addOption(new Option('--xaa', 'authenticate through the cross-app-access IdP').hideHelp(!isXaaEnabled()))
    .addHelpText(
      'after',
      `
Examples:
  ${cli} mcp add docs https://docs.example.com/mcp --transport http
  ${cli} mcp add gateway https://gw.example.com/mcp --transport http --header "Authorization: Bearer TOKEN"
  ${cli} mcp add tools -e API_KEY=secret -- npx run-tools
  ${cli} mcp add runner -- my-server --flag value`,
    )
    .action(
      async (
        name: string | undefined,
        commandOrUrl: string | undefined,
        args: string[],
        options: {
          scope?: string
          transport?: string
          env?: string[]
          header?: string[]
          clientId?: string
          clientSecret?: boolean
          callbackPort?: string
          xaa?: boolean
        },
      ) => {
        try {
          if (!name) {
            cliError(`Usage: ${cli} mcp add <name> <commandOrUrl> [args...]`)
          }
          if (!commandOrUrl) {
            cliError(
              `A command (or URL) is required when a server name is given.\nUsage: ${cli} mcp add <name> <commandOrUrl> [args...]`,
            )
          }

          const scope = ensureConfigScope(options.scope)
          const transport = ensureTransport(options.transport)
          const transportExplicit =
            options.transport !== undefined && options.transport !== ''

          // XAA fails fast at ADD time, not at first auth.
          if (options.xaa) {
            if (!isXaaEnabled()) {
              cliError('--xaa is not available: cross-app access is disabled in this build')
            }
            const missing: string[] = []
            if (!options.clientId) missing.push('--client-id')
            if (!options.clientSecret) missing.push('--client-secret')
            if (!getXaaIdpSettings()) {
              missing.push(`a configured IdP (run \`${cli} mcp xaa setup\`; settings key xaaIdp)`)
            }
            if (missing.length > 0) {
              cliError(`--xaa requires: ${missing.join(', ')}`)
            }
          }

          if (transport === 'sse' || transport === 'http') {
            const headers = options.header ? parseHeaders(options.header) : undefined
            const callbackPort =
              options.callbackPort !== undefined
                ? parseInt(options.callbackPort, 10)
                : undefined
            const wantsOauth =
              Boolean(options.clientId) || callbackPort !== undefined || options.xaa === true
            const oauth = wantsOauth
              ? {
                  ...(options.clientId ? { clientId: options.clientId } : {}),
                  ...(callbackPort !== undefined ? { callbackPort } : {}),
                  ...(options.xaa === true ? { xaa: true } : {}),
                }
              : undefined
            const clientSecret =
              options.clientSecret && options.clientId ? await readClientSecret() : undefined

            const config: McpServerConfig = {
              type: transport,
              url: commandOrUrl,
              ...(headers ? { headers } : {}),
              ...(oauth ? { oauth } : {}),
            } as McpServerConfig
            await addMcpConfig(name, config, scope)
            if (clientSecret !== undefined) {
              saveMcpClientSecret(name, config, clientSecret)
            }
            let confirmation = `Added ${transport.toUpperCase()} MCP server ${name} at ${commandOrUrl} (${scope} scope)`
            if (headers) {
              // Names ride, credential values mask — a --header
              // authorization: Bearer … must never echo into the record.
              confirmation += `\nheaders: ${describeHeadersRedacted(headers)}`
            }
            cliOk(`${confirmation}\nConfiguration written to ${describeMcpConfigFilePath(scope)}`)
          }

          // stdio
          const ignoredOauthFlags: string[] = []
          if (options.clientId) ignoredOauthFlags.push('--client-id')
          if (options.clientSecret) ignoredOauthFlags.push('--client-secret')
          if (options.callbackPort) ignoredOauthFlags.push('--callback-port')
          if (ignoredOauthFlags.length > 0) {
            process.stderr.write(
              `Warning: ${ignoredOauthFlags.join(', ')} only apply to SSE/HTTP transports and are ignored for stdio.\n`,
            )
          }
          if (!transportExplicit && looksLikeUrl(commandOrUrl)) {
            process.stderr.write(
              `Warning: "${commandOrUrl}" looks like a URL but no transport was specified, so it is being registered as a stdio COMMAND.\n` +
                `For a remote server use:\n` +
                `  ${cli} mcp add ${name} ${commandOrUrl} --transport http\n` +
                `  ${cli} mcp add ${name} ${commandOrUrl} --transport sse\n`,
            )
          }
          const env = options.env ? parseEnvAssignments(options.env) : undefined
          const config: McpServerConfig = {
            type: 'stdio',
            command: commandOrUrl,
            args: args ?? [],
            ...(env ? { env } : {}),
          } as McpServerConfig
          await addMcpConfig(name, config, scope)
          cliOk(
            `Added stdio MCP server ${name} (${[commandOrUrl, ...(args ?? [])].join(' ')}) in ${scope} scope\nConfiguration written to ${describeMcpConfigFilePath(scope)}`,
          )
        } catch (error) {
          cliError(error instanceof Error ? error.message : String(error))
        }
      },
    )
}
