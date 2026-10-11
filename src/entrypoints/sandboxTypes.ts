import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

const flag = (meaning: string) => z.boolean().optional().describe(meaning)
const patterns = (meaning: string) => z.array(z.string()).optional().describe(meaning)
const port = (meaning: string) => z.number().optional().describe(meaning)

const networkReach = () =>
  z
    .object({
      allowedDomains: patterns('Domains the sandboxed process may reach'),
      allowManagedDomainsOnly: flag('Restrict network access to managed domains only'),
      allowUnixSockets: patterns('Unix socket paths reachable from the sandbox'),
      allowAllUnixSockets: flag('Allow every unix socket'),
      allowLocalBinding: flag('Allow binding local ports'),
      httpProxyPort: port('HTTP proxy port'),
      socksProxyPort: port('SOCKS proxy port'),
    })
    .optional()

const filesystemReach = () =>
  z
    .object({
      allowWrite: patterns('Writable path patterns'),
      denyWrite: patterns('Write-denied path patterns'),
      denyRead: patterns('Read-denied path patterns'),
      allowRead: patterns('Readable path patterns'),
      allowManagedReadPathsOnly: flag('Restrict reads to managed paths only'),
    })
    .optional()

const searchToolOverride = () =>
  z
    .object({ command: z.string(), args: z.array(z.string()).optional() })
    .optional()
    .describe('Search-tool binary override')

export const SandboxSettingsSchema = lazySchema(() =>
  z.looseObject({
    enabled: flag('Whether sandboxing is on'),
    failIfUnavailable: flag('Refuse to run when the sandbox cannot be established'),
    autoAllowBashIfSandboxed: flag('Auto-approve shell commands that run sandboxed'),
    allowUnsandboxedCommands: flag('Permit commands to escape the sandbox when needed'),
    network: networkReach(),
    filesystem: filesystemReach(),
    ignoreViolations: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe('Violation patterns to ignore, keyed by command'),
    enableWeakerNestedSandbox: flag('Allow the weaker nested-sandbox fallback'),
    enableWeakerNetworkIsolation: flag('Allow the weaker network-isolation fallback'),
    excludedCommands: patterns('Commands excluded from sandboxing'),
    enabledPlatforms: patterns('The platforms the sandbox runs on (macos, linux, wsl); absent means every supported platform'),
    ripgrep: searchToolOverride(),
  }),
)
