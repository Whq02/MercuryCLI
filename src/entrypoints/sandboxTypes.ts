// ============================================================================
//  src/entrypoints/sandboxTypes.ts — sandbox settings schemas (network /
//  filesystem / top-level) plus inferred types. Both the SDK and the
//  settings validation import from here — this module is the single source
//  of truth for the sandbox settings shape.
//
//  The settings schema is PASSTHROUGH: unlisted keys survive validation. At
//  least one shipped setting (a platform allow-list) is read only through
//  the passthrough — stripping unknown keys silently drops operator
//  configuration.
// ============================================================================
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

export const SandboxNetworkConfigSchema = lazySchema(() =>
  z
    .object({
      allowedDomains: z
        .array(z.string())
        .optional()
        .describe('Domains the sandboxed process may reach'),
      allowManagedDomainsOnly: z
        .boolean()
        .optional()
        .describe('Restrict network access to managed domains only'),
      allowUnixSockets: z
        .array(z.string())
        .optional()
        .describe('Unix socket paths reachable from the sandbox'),
      allowAllUnixSockets: z
        .boolean()
        .optional()
        .describe('Allow every unix socket'),
      allowLocalBinding: z
        .boolean()
        .optional()
        .describe('Allow binding local ports'),
      httpProxyPort: z.number().optional().describe('HTTP proxy port'),
      socksProxyPort: z.number().optional().describe('SOCKS proxy port'),
    })
    .optional(),
)

export const SandboxFilesystemConfigSchema = lazySchema(() =>
  z
    .object({
      allowWrite: z.array(z.string()).optional().describe('Writable path patterns'),
      denyWrite: z.array(z.string()).optional().describe('Write-denied path patterns'),
      denyRead: z.array(z.string()).optional().describe('Read-denied path patterns'),
      allowRead: z.array(z.string()).optional().describe('Readable path patterns'),
      allowManagedReadPathsOnly: z
        .boolean()
        .optional()
        .describe('Restrict reads to managed paths only'),
    })
    .optional(),
)

export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional().describe('Whether sandboxing is on'),
      failIfUnavailable: z
        .boolean()
        .optional()
        .describe('Refuse to run when the sandbox cannot be established'),
      autoAllowBashIfSandboxed: z
        .boolean()
        .optional()
        .describe('Auto-approve shell commands that run sandboxed'),
      allowUnsandboxedCommands: z
        .boolean()
        .optional()
        .describe('Permit commands to escape the sandbox when needed'),
      network: SandboxNetworkConfigSchema(),
      filesystem: SandboxFilesystemConfigSchema(),
      ignoreViolations: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe('Violation patterns to ignore, keyed by command'),
      enableWeakerNestedSandbox: z
        .boolean()
        .optional()
        .describe('Allow the weaker nested-sandbox fallback'),
      enableWeakerNetworkIsolation: z
        .boolean()
        .optional()
        .describe('Allow the weaker network-isolation fallback'),
      excludedCommands: z
        .array(z.string())
        .optional()
        .describe('Commands excluded from sandboxing'),
      ripgrep: z
        .object({ command: z.string(), args: z.array(z.string()).optional() })
        .optional()
        .describe('Search-tool binary override'),
    })
    // Unlisted keys survive validation (see the module header).
    .passthrough(),
)

export type SandboxSettings = z.infer<ReturnType<typeof SandboxSettingsSchema>>
export type SandboxNetworkConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxNetworkConfigSchema>>
>
export type SandboxFilesystemConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxFilesystemConfigSchema>>
>
export type SandboxIgnoreViolations = SandboxSettings['ignoreViolations']
