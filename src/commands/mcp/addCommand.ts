import { type Command as CommanderCommand } from 'commander'
import { cliError, cliOk } from '../../cli/exit.js'
import { addMcpConfig } from '../../services/mcp/config.js'
import { readClientSecret, saveMcpClientSecret } from '../../services/mcp/auth.js'
import { McpServerConfigSchema, type McpServerConfig } from '../../utils/mcp/types.js'
import {
  describeMcpConfigFilePath,
  ensureConfigScope,
  ensureTransport,
  parseHeaders,
} from '../../services/mcp/utils.js'
import { binaryName } from '../../utils/config/derived.js'
import { describeHeadersRedacted, describeUrlRedacted } from '../../utils/redactHeaders.js'

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

type McpAddOptions = {
  scope?: string
  transport?: string
  env?: string[]
  header?: string[]
  clientId?: string
  clientSecret?: boolean
  callbackPort?: string
}

function resemblesUrl(value: string): boolean {
  const lower = value.toLowerCase()
  const pathPart = lower.split(/[?#]/, 1)[0] ?? lower
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('localhost') ||
    pathPart.endsWith('/sse') ||
    pathPart.endsWith('/mcp')
  )
}

function collectList(value: string, previous: string[]): string[] {
  return [...previous, value]
}

export function registerMcpAddCommand(mcp: CommanderCommand): void {
  const cmd = binaryName()
  mcp
    .command('add')
    .description('Add an MCP server')
    .argument('[name]')
    .argument('[commandOrUrl]', 'the command to launch it, or its URL')
    .argument('[args...]', 'stdio subprocess arguments')
    .option('-s, --scope <scope>', 'configuration scope (local, user, or project)', 'local')
    .option('-t, --transport <transport>', 'transport type (stdio, sse, http)')
    .option('-e, --env <env...>', 'environment variables for a stdio server (KEY=VALUE)', collectList, [])
    .option('-H, --header <header...>', 'HTTP headers for an SSE/HTTP server', collectList, [])
    .option('--client-id <clientId>', 'OAuth client id')
    .option('--client-secret', 'read the OAuth client secret (prompt, or MERCURY_MCP_CLIENT_SECRET)')
    .option('--callback-port <port>', 'fixed OAuth callback port')
    .addHelpText(
      'after',
      `\nExamples:\n  ${cmd} mcp add docs https://docs.example.com/mcp --transport http\n  ${cmd} mcp add gateway https://gw.example.com/mcp --transport http --header "Authorization: Bearer TOKEN"\n  ${cmd} mcp add tools -e API_KEY=secret -- npx run-tools\n  ${cmd} mcp add runner -- my-server --flag value\n`,
    )
    .action(async (name: string | undefined, commandOrUrl: string | undefined, args: string[] | undefined, options: McpAddOptions) => {
      let summary: string
      try {
        if (!name) {
          throw new Error(`Usage: ${cmd} mcp add <name> <commandOrUrl> [args...]`)
        }
        if (!commandOrUrl) {
          throw new Error('A command (or URL) is required when a server name is given.')
        }

        const scope = ensureConfigScope(options.scope)
        const transport = ensureTransport(options.transport)

        if (!options.transport && resemblesUrl(commandOrUrl)) {
          const redacted = describeUrlRedacted(commandOrUrl)
          const remoteExamples = ['http', 'sse']
            .map(remoteTransport => `  ${cmd} mcp add ${name} ${redacted} --transport ${remoteTransport}`)
            .join('\n')
          process.stderr.write(
            `Warning: "${redacted}" looks like a URL but no transport was specified, so it is being registered as a stdio COMMAND.\nFor a remote server use:\n${remoteExamples}\n`,
          )
        }

        let rawConfig: unknown
        let headers: Record<string, string> | undefined
        let shouldReadSecret = false

        if (transport === 'sse' || transport === 'http') {
          headers = options.header && options.header.length > 0 ? parseHeaders(options.header) : undefined
          const callbackPort =
            options.callbackPort !== undefined
              ? /^\d+$/.test(options.callbackPort.trim())
                ? Number.parseInt(options.callbackPort.trim(), 10)
                : Number.NaN
              : undefined
          const oauth =
            options.clientId !== undefined || callbackPort !== undefined
              ? {
                  ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
                  ...(callbackPort !== undefined ? { callbackPort } : {}),
                }
              : undefined
          shouldReadSecret = Boolean(options.clientSecret) && options.clientId !== undefined
          rawConfig = {
            type: transport,
            url: commandOrUrl,
            ...(headers !== undefined ? { headers } : {}),
            ...(oauth !== undefined ? { oauth } : {}),
          }
        } else {
          const ignoredOAuthFlags: string[] = []
          if (options.clientId !== undefined) ignoredOAuthFlags.push('--client-id')
          if (options.clientSecret) ignoredOAuthFlags.push('--client-secret')
          if (options.callbackPort !== undefined) ignoredOAuthFlags.push('--callback-port')
          if (ignoredOAuthFlags.length > 0) {
            process.stderr.write(
              `Warning: ${ignoredOAuthFlags.join(', ')} only apply to SSE/HTTP transports and are ignored for stdio.\n`,
            )
          }
          const env = options.env && options.env.length > 0 ? parseEnvAssignments(options.env) : undefined
          rawConfig = {
            type: 'stdio',
            command: commandOrUrl,
            args: args ?? [],
            ...(env !== undefined ? { env } : {}),
          }
        }

        const parsed = McpServerConfigSchema().safeParse(rawConfig)
        if (!parsed.success) {
          const detail = parsed.error.issues.map(issue => issue.message).join(', ')
          throw new Error(`Invalid MCP server configuration: ${detail}`)
        }
        const config: McpServerConfig = parsed.data

        const clientSecret = shouldReadSecret ? await readClientSecret() : undefined
        await addMcpConfig(name, config, scope)
        if (clientSecret !== undefined) {
          saveMcpClientSecret(name, config, clientSecret)
        }

        if (transport === 'sse' || transport === 'http') {
          const lines = [
            `Added ${transport.toUpperCase()} MCP server ${name} with URL: ${describeUrlRedacted(commandOrUrl)} to ${scope} config`,
          ]
          if (headers !== undefined && Object.keys(headers).length > 0) {
            lines.push(`Headers: ${describeHeadersRedacted(headers)}`)
          }
          lines.push(`Configuration written to ${describeMcpConfigFilePath(scope)}`)
          summary = lines.join('\n')
        } else {
          const commandSummary = [commandOrUrl, ...(args ?? [])].join(' ')
          summary = `Added stdio MCP server ${name} with command: ${commandSummary} to ${scope} config\nConfiguration written to ${describeMcpConfigFilePath(scope)}`
        }
      } catch (error) {
        cliError(error instanceof Error ? error.message : String(error))
      }
      cliOk(summary)
    })
}
