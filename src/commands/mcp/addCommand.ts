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

function inferTransport(commandOrUrl: string): 'stdio' | 'sse' | 'http' {
  const lower = commandOrUrl.toLowerCase()
  const pathPart = lower.split(/[?#]/, 1)[0] ?? lower
  if (pathPart.endsWith('/sse')) return 'sse'
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('localhost') ||
    pathPart.endsWith('/mcp')
  ) {
    return 'http'
  }
  return 'stdio'
}

export function registerMcpAddCommand(mcp: CommanderCommand): void {
  const cmd = binaryName()
  mcp
    .command('add [name] [commandOrUrl] [args...]')
    .description('Add an MCP server to Mercury')
    .option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local')
    .option('-t, --transport <transport>', 'Transport type (stdio, sse, http)')
    .option('-e, --env <env...>', 'Set environment variables (e.g. -e KEY=value)')
    .option('-H, --header <header...>', 'Set HTTP headers (e.g. -H "X-Api-Key: abc123")')
    .option('--client-id <clientId>', 'OAuth client ID for HTTP/SSE servers')
    .option('--client-secret', 'Prompt for an OAuth client secret (or set MERCURY_MCP_CLIENT_SECRET)')
    .option('--callback-port <port>', 'Fixed port for the OAuth redirect callback')
    .addHelpText(
      'after',
      `\nExamples:\n  ${cmd} mcp add my-server -- npx -y @example/mcp-server\n  ${cmd} mcp add --transport http my-api https://example.com/mcp\n  ${cmd} mcp add --transport sse my-sse https://example.com/sse --header "Authorization: Bearer token"\n  ${cmd} mcp add --scope user -e API_KEY=value my-tool -- node server.js\n`,
    )
    .action(async (name: string | undefined, commandOrUrl: string | undefined, args: string[] | undefined, options: McpAddOptions) => {
      let summary: string
      try {
        if (!name || !commandOrUrl) {
          throw new Error('Missing required arguments: <name> and <commandOrUrl>. Run with --help for usage.')
        }

        const scope = ensureConfigScope(options.scope)
        const transport =
          options.transport !== undefined
            ? ensureTransport(options.transport)
            : inferTransport(commandOrUrl)

        let callbackPort: number | undefined
        if (options.callbackPort !== undefined) {
          const parsedPort = Number.parseInt(options.callbackPort, 10)
          if (!Number.isInteger(parsedPort) || parsedPort <= 0 || String(parsedPort) !== options.callbackPort.trim()) {
            throw new Error(`Invalid --callback-port "${options.callbackPort}" — expected a positive integer port number`)
          }
          callbackPort = parsedPort
        }

        let rawConfig: unknown
        let headers: Record<string, string> | undefined
        if (transport === 'sse' || transport === 'http') {
          headers = options.header && options.header.length > 0 ? parseHeaders(options.header) : undefined
          const oauth =
            options.clientId !== undefined || callbackPort !== undefined
              ? {
                  ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
                  ...(callbackPort !== undefined ? { callbackPort } : {}),
                }
              : undefined
          rawConfig = {
            type: transport,
            url: commandOrUrl,
            ...(headers !== undefined ? { headers } : {}),
            ...(oauth !== undefined ? { oauth } : {}),
          }
        } else {
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

        const clientSecret = options.clientSecret ? await readClientSecret() : undefined
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
          lines.push(`File modified: ${describeMcpConfigFilePath(scope)}`)
          summary = lines.join('\n')
        } else {
          const commandSummary = [commandOrUrl, ...(args ?? [])].join(' ')
          summary = `Added stdio MCP server ${name} with command: ${commandSummary} to ${scope} config\nFile modified: ${describeMcpConfigFilePath(scope)}`
        }
      } catch (error) {
        cliError(error instanceof Error ? error.message : String(error))
      }
      cliOk(summary)
    })
}
