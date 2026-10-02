import { z } from 'zod/v4'

import { SandboxSettingsSchema } from '../../entrypoints/sandboxTypes.js'
import { EFFORT_LEVELS } from '../../entrypoints/sdk/runtimeTypes.js'
import { HooksSchema } from '../../schemas/hooks.js'
import { lazySchema } from '../lazySchema.js'
import { PERMISSION_MODES } from '../permissions/PermissionMode.js'
import { PermissionRuleSchema } from './permissionValidation.js'
import type { HookCommand } from '../../schemas/hooks.js'

export { HookCommandSchema, HookMatcherSchema, HooksSchema } from '../../schemas/hooks.js'
export type { AgentHook, BashCommandHook, HookCommand, HookMatcher, HooksSettings, HttpHook, PromptHook } from '../../schemas/hooks.js'

export const CUSTOMIZATION_SURFACES = ['skills', 'agents', 'hooks', 'mcp'] as const

export const EnvironmentVariablesSchema = lazySchema(() =>
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(value => String(value))),
)

const mcpEntryShape = {
  serverName: z.string().regex(/^[A-Za-z0-9_-]+$/, 'serverName may contain only letters, digits, hyphens and underscores').optional(),
  serverCommand: z.array(z.string()).min(1).optional(),
  serverUrl: z.string().optional(),
}

function requireExactlyOneField(
  entry: { serverName?: unknown; serverCommand?: unknown; serverUrl?: unknown },
  ctx: { addIssue: (issue: never) => void },
): void {
  const present = [entry.serverName, entry.serverCommand, entry.serverUrl].filter(field => field !== undefined).length
  if (present !== 1) ctx.addIssue({ code: 'custom', message: 'Exactly one of serverName, serverCommand, or serverUrl must be set' } as never)
}

export const AllowedMcpServerEntrySchema = lazySchema(() => z.object(mcpEntryShape).superRefine(requireExactlyOneField))
export const DeniedMcpServerEntrySchema = lazySchema(() => z.object(mcpEntryShape).superRefine(requireExactlyOneField))
export type AllowedMcpServerEntry = z.infer<ReturnType<typeof AllowedMcpServerEntrySchema>>
export type DeniedMcpServerEntry = z.infer<ReturnType<typeof DeniedMcpServerEntrySchema>>

export function isMcpServerNameEntry(entry: AllowedMcpServerEntry | DeniedMcpServerEntry): entry is AllowedMcpServerEntry & { serverName: string } {
  return typeof (entry as { serverName?: unknown }).serverName === 'string'
}
export function isMcpServerCommandEntry(entry: AllowedMcpServerEntry | DeniedMcpServerEntry): entry is AllowedMcpServerEntry & { serverCommand: string[] } {
  return Array.isArray((entry as { serverCommand?: unknown }).serverCommand)
}
export function isMcpServerUrlEntry(entry: AllowedMcpServerEntry | DeniedMcpServerEntry): entry is AllowedMcpServerEntry & { serverUrl: string } {
  return typeof (entry as { serverUrl?: unknown }).serverUrl === 'string'
}

const modeLockSchema = () => z.preprocess(
  value => value === undefined || typeof value === 'boolean' ? value : true,
  z.boolean(),
).optional()

export const PermissionsSchema = lazySchema(() =>
  z.object({
    allow: z.array(PermissionRuleSchema()).optional(),
    deny: z.array(PermissionRuleSchema()).optional(),
    ask: z.array(PermissionRuleSchema()).optional(),
    mode: z.enum(PERMISSION_MODES).optional(),
    disableSovereignMode: modeLockSchema().describe('True closes Sovereign mode for every session that reads this file'),
    disableFlowMode: modeLockSchema().describe('True closes Flow for every session that reads this file'),
    reasons: z.record(z.string(), z.string()).optional().describe('The words a refusal or a consent card says for a rule, keyed by the rule spelling as written in allow, deny or ask'),
    managedOnly: z.boolean().optional(),
    sovereignConsentSeen: z.boolean().optional().describe('True skips the consent card shown before entering Sovereign mode (honoured from the user, local, flag and policy sources)'),
    sandbox: SandboxSettingsSchema().optional(),
  }).passthrough(),
)

export type ExtensionHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  extensionName: string
  extensionRoot: string
  extensionId: string
}
export type SkillHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  skillName: string
  skillRoot: string
}

const userConfigValueSchema = (): z.ZodType => z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])

export const ExtensionsSettingsSchema = lazySchema(() =>
  z.object({
    enabled: z.record(z.string(), z.boolean()).optional(),
    wanted: z.array(z.object({ name: z.string(), source: z.string(), ref: z.string().optional() })).optional(),
    blocked: z.array(z.string()).optional(),
    options: z.record(z.string(), z.record(z.string(), userConfigValueSchema())).optional(),
    exclusive: z.preprocess(value => {
      const surfaces = CUSTOMIZATION_SURFACES as readonly string[]
      if (Array.isArray(value)) return value.filter(entry => surfaces.includes(entry as string))
      if (typeof value === 'string') {
        const folded = value.trim().toLowerCase()
        if (folded === 'true' || folded === '1') return true
        if (folded === 'false' || folded === '0' || folded === '') return false
        if (surfaces.includes(folded)) return [folded]
        return true
      }
      if (value !== undefined && typeof value !== 'boolean') return true
      return value
    }, z.union([z.boolean(), z.array(z.enum(CUSTOMIZATION_SURFACES))]))
      .optional().catch(undefined)
      .describe("Managed lock restricting customization surfaces to extensions (filesystem sources such as the config home's skills directory are skipped for locked surfaces)"),
  }),
)
export type ExtensionsSettings = z.infer<ReturnType<typeof ExtensionsSettingsSchema>>

export const SettingsSchema = lazySchema(() => {
  const base = z.object({
    $schema: z.string().optional(),
    credentials: z.object({
      keyCommand: z.string().optional(),
      proxyCommand: z.string().optional(),
      signInRoute: z.enum(['claudeai', 'console']).optional(),
      organisation: z.string().optional(),
    }).passthrough().optional(),
    files: z.object({
      suggester: z.object({ type: z.literal('command'), command: z.string() }).optional(),
      honourGitignore: z.boolean().optional(),
    }).passthrough().optional(),
    records: z.object({ retentionDays: z.number().int().min(0).optional() }).passthrough().optional(),
    briefs: z.object({
      exclude: z.array(z.string()).optional().describe('Glob patterns or absolute paths of instruction files to skip (e.g. ~/.mercury/MERCURY.md or **/.mercury/rules/*.md); managed layers cannot be excluded'),
      git: z.boolean().optional(),
      profile: z.enum(['auto', 'native']).optional(),
    }).passthrough().optional(),
    memory: z.object({
      enabled: z.boolean().optional(),
      directory: z.string().optional().describe('Where auto memory is written (default under the Mercury config home); ignored when set by checked-in project settings'),
      pinnedLimit: z.number().int().min(1000).optional().describe('How much pinned memory text (characters) loads into every session before Mercury says the shelf is full; every pinned rule still loads past it (default 8000)'),
    }).passthrough().optional(),
    turns: z.object({
      loopGuard: z.boolean().optional().describe('Loop guard turn end: when true, the second detection of one repeated cycle of tool calls (or one chanted stretch of reply text) ends the turn with a loop_stopped result; absent or false, these cycles only draw reminders; headless runs still end after eight consecutive identical failing tool calls'),
    }).passthrough().optional(),
    environment: z.object({ values: EnvironmentVariablesSchema().optional() }).passthrough().optional(),
    credit: z.object({
      lines: z.object({ commit: z.string().optional(), pr: z.string().optional() }).optional(),
      mercury: z.boolean().optional(),
    }).passthrough().optional(),
    guardrails: PermissionsSchema().optional(),
    engine: z.object({
      model: z.string().optional(),
      roster: z.array(z.string()).optional(),
      pins: z.record(z.string(), z.string()).optional(),
      effort: z.enum(EFFORT_LEVELS).optional().catch(undefined),
      sessionDefaults: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      agent: z.string().optional(),
    }).passthrough().optional(),
    kit: z.object({
      trustProjectServers: z.boolean().optional(),
      projectOn: z.array(z.string()).optional(),
      projectOff: z.array(z.string()).optional(),
      permit: z.array(AllowedMcpServerEntrySchema()).optional(),
      deny: z.array(DeniedMcpServerEntrySchema()).optional(),
      managedOnly: z.boolean().optional(),
    }).passthrough().optional(),
    events: z.object({
      hooks: HooksSchema().optional(),
      disabled: z.boolean().optional(),
      managedOnly: z.boolean().optional(),
      httpDestinations: z.array(z.string()).optional(),
      httpEnvironment: z.array(z.string()).optional(),
    }).passthrough().optional(),
    extensions: ExtensionsSettingsSchema().optional(),
    voice: z.object({ language: z.string().optional() }).passthrough().optional(),
    activity: z.object({
      tips: z.object({
        enabled: z.boolean().optional(),
        words: z.object({ excludeDefault: z.boolean().optional(), tips: z.array(z.string()) }).optional(),
      }).passthrough().optional(),
      verbs: z.object({ mode: z.enum(['append', 'replace']), verbs: z.array(z.string()) }).optional(),
      progress: z.boolean().optional(),
    }).passthrough().optional(),
    view: z.object({
      files: z.boolean().optional(),
      modelPicker: z.object({ centred: z.boolean().optional().describe('Where the model picker opens over the chat: centred (the default), or false for the left edge') }).passthrough().optional(),
      syntaxOff: z.boolean().optional(),
      reducedMotion: z.boolean().optional(),
      backgroundKey: z.boolean().optional(),
      sessionsBar: z.boolean().optional().describe('Show the SESSIONS bar along the bottom of the chat (/view on); off unless set'),
      firstRunCards: z.enum(['centred', 'top-left']).optional().describe('Where the first-run cards sit: centred on the screen with the trust tone in brown (the default), or top-left with the amber tone'),
    }).passthrough().optional(),
    context: z.object({ wayBack: z.boolean().optional() }).passthrough().optional(),
    input: z.object({ suggestions: z.boolean().optional() }).passthrough().optional(),
    shell: z.object({
      kind: z.enum(['bash', 'powershell']).optional(),
      engine: z.enum(['system', 'brush']).optional(),
      sessions: z.number().int().min(1).max(64).optional().describe("The ceiling on live shell-engine sessions Mercury keeps at once: the main conversation's own plus that many minus one for sub-agents (default 8). A sub-agent past the ceiling waits for a free session, never sharing another owner's; a ceiling of 1 leaves no session for sub-agents"),
    }).passthrough().optional(),
    patience: z.union([
      z.enum(['normal', 'patient']),
      z.object({
        streamIdleSeconds: z.number().positive().optional(),
        quietStreamIdleSeconds: z.number().positive().optional(),
        fallbackCeilingSeconds: z.number().positive().optional(),
        recoveryBudgetMinutes: z.number().min(0).optional(),
      }).describe('Custom patience: the stream-idle budget in seconds on the roads whose keep-alives feed the watchdog, the same budget on the quiet roads (silent while the model reasons), the non-streamed fallback ceiling in seconds, and the retry budget in minutes (0 = no budget); a missing number takes the normal one'),
    ]).optional().describe('Patience with a quiet model: normal (a 6 min stream-idle budget where keep-alives feed the watchdog, 15 min on the quiet roads, a 15 min non-streamed fallback ceiling, a 20 min retry budget), patient (every wait doubled), or the custom numbers; MERCURY_STREAM_IDLE_TIMEOUT_MS, MERCURY_API_TIMEOUT_MS and MERCURY_RECOVERY_BUDGET_MINUTES outrank it'),
    routing: z.object({
      openrouter: z.object({
        dataCollection: z.enum(['allow', 'deny']).optional(),
        requireParameters: z.boolean().optional(),
        allowFallbacks: z.boolean().optional(),
        zeroDataRetention: z.boolean().optional(),
      }).optional().describe('OpenRouter routing policy: denies data collection and requires every parameter by default, even when absent, with fallbacks on and zero data retention off; an explicit all-off setting (dataCollection: allow, requireParameters: false, allowFallbacks: true, zeroDataRetention: false) sends no routing preference'),
    }).passthrough().optional(),
    channels: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    apollo: z.object({ preflightQuestions: z.number().int().min(1).max(20).optional() }).optional().describe('Apollo Mode: pre-flight interview poll budget (default 7)'),
    workspace: z.object({
      worktree: z.object({ symlinkDirectories: z.array(z.string()).optional(), sparsePaths: z.array(z.string()).optional() }).optional(),
    }).passthrough().optional(),
    local: z.object({
      server: z.object({
        maxLoadedModels: z.number().int().min(1).max(64).optional().describe('How many models the local server keeps loaded at once (OLLAMA_MAX_LOADED_MODELS; the server documents 3 per GPU when unset)'),
        parallelSlots: z.number().int().min(1).max(64).optional().describe('How many requests one loaded model answers at once, each slot holding its own window of cache (OLLAMA_NUM_PARALLEL; the server documents 1 when unset)'),
        keepAlive: z.string().regex(/^(-?\d+|-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/, 'a duration such as 30m, 24h or 3600, -1 to keep loaded, 0 to unload at once').optional().describe('How long an idle model stays loaded (OLLAMA_KEEP_ALIVE; the server documents 5m when unset)'),
        contextLength: z.number().int().min(512).max(10_485_760).optional().describe('The context length a request gets when it names none (OLLAMA_CONTEXT_LENGTH; the server documents 4096 when unset)'),
      }).optional().describe("The local model server's own knobs, written into its launch form (a launch agent plist, a systemd override) and applied by a restart only on your confirmation from /config; the values Mercury would write, beside the running server's own"),
    }).passthrough().optional(),
  })
  return base.passthrough()
})

export type SettingsJson = z.infer<z.ZodObject<ReturnType<typeof SettingsSchema>['shape']>>
