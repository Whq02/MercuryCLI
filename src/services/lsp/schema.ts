// ============================================================================
//  src/services/lsp/schema.ts — the language-server config shape. ONE
//  schema serves every source: the operator's MERCURY_LSP_SERVERS JSON,
//  the built-in lanes, and an extension's `contributes.language` block.
//  Strict: an unknown key fails. Every field carries `.describe()` so the
//  extensions contract generator renders it.
// ============================================================================
import { z } from 'zod'
import { lazySchema } from '../../utils/lazySchema.js'

export const LspServerConfigSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .min(1, 'LSP server "command" cannot be empty')
      .refine(
        command => !command.includes(' ') || command.startsWith('/'),
        'LSP server "command" must be a single executable — move arguments into the "args" array (an absolute path may contain spaces)',
      )
      .describe('The executable to spawn (a bare name is looked up on PATH; an absolute path may contain spaces).'),
    args: z.array(z.string().min(1, 'LSP server args cannot be empty strings')).optional().describe('Arguments passed to the server.'),
    extensionToLanguage: z
      .record(
        z
          .string()
          .regex(
            /^\..+$/,
            'extensionToLanguage keys are file extensions and must begin with a dot (for example ".py", not "py")',
          ),
        z.string().min(1, 'extensionToLanguage values must be language identifiers'),
      )
      .refine(
        record => Object.keys(record).length > 0,
        'extensionToLanguage must declare at least one file extension',
      )
      .describe('File extension (with the dot) → language identifier; at least one entry.'),
    transport: z.enum(['stdio', 'socket']).default('stdio').describe("'stdio' (default) or 'socket'."),
    env: z.record(z.string(), z.string()).optional().describe('Environment for the spawned process.'),
    initializationOptions: z.unknown().optional().describe("Server-specific `initialize` options (opaque)."),
    settings: z.unknown().optional().describe('Server settings sent with `workspace/didChangeConfiguration` (opaque).'),
    workspaceFolder: z.string().optional().describe('The workspace root to initialise the server with.'),
    startupTimeout: z.number().int().positive().optional().describe('Milliseconds to wait for `initialize` before failing.'),
    shutdownTimeout: z.number().int().positive().optional().describe('Milliseconds to wait for the graceful shutdown before the child is killed (default 2000).'),
    requestTimeout: z.number().int().positive().optional().describe('Milliseconds a single request may wait for its answer before it is cancelled and refused (default 30000); one budget covers a whole call, retries included.'),
    restartOnCrash: z.boolean().optional().describe('Whether a crashed server may restart lazily on next use (default true).'),
    maxRestarts: z.number().int().nonnegative().optional().describe('Cap on (re)start attempts before giving up.'),
    disabled: z
      .boolean()
      .optional()
      .describe('Skip this server entirely (the row stays visible to status surfaces as disabled).'),
    diagnosticsOnly: z
      .boolean()
      .optional()
      .describe(
        'A linter-class lane: participates in document sync and diagnostics, never as the primary for navigation/refactor operations.',
      ),
    idleTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Stop the server after this long with no requests; it restarts lazily on next use.'),
    rootMarkers: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Workspace files that mark a project this server owns ("Cargo.toml", "*.sln") — detection metadata for catalogue-style offers.',
      ),
  }),
)

export type LspServerConfigInput = z.input<ReturnType<typeof LspServerConfigSchema>>
