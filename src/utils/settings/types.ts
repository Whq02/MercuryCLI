import { z } from 'zod/v4'

import { SandboxSettingsSchema } from '../../entrypoints/sandboxTypes.js'
import { HooksSchema } from '../../schemas/hooks.js'
import { isEnvTruthy } from '../envUtils.js'
import { lazySchema } from '../lazySchema.js'
import { PERMISSION_MODES, decodePermissionModeSpelling } from '../permissions/PermissionMode.js'
import { PermissionRuleSchema } from './permissionValidation.js'


import type { HookCommand } from '../../schemas/hooks.js'

export {
  HookCommandSchema,
  HookMatcherSchema,
  HooksSchema,
} from '../../schemas/hooks.js'
export type {
  AgentHook,
  BashCommandHook,
  HookCommand,
  HookMatcher,
  HooksSettings,
  HttpHook,
  PromptHook,
} from '../../schemas/hooks.js'

export const CUSTOMIZATION_SURFACES = ['skills', 'agents', 'hooks', 'mcp'] as const

export const EnvironmentVariablesSchema = lazySchema(() =>
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(value => String(value))),
)

const mcpEntryShape = {
  serverName: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'serverName may contain only letters, digits, hyphens and underscores')
    .optional(),
  serverCommand: z.array(z.string()).min(1).optional(),
  serverUrl: z.string().optional(),
}

function requireExactlyOneField(
  entry: { serverName?: unknown; serverCommand?: unknown; serverUrl?: unknown },
  ctx: { addIssue: (issue: never) => void },
): void {
  const present = [entry.serverName, entry.serverCommand, entry.serverUrl].filter(
    field => field !== undefined,
  ).length
  if (present !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Exactly one of serverName, serverCommand, or serverUrl must be set',
    } as never)
  }
}

export const AllowedMcpServerEntrySchema = lazySchema(() =>
  z.object(mcpEntryShape).superRefine(requireExactlyOneField),
)

export const DeniedMcpServerEntrySchema = lazySchema(() =>
  z.object(mcpEntryShape).superRefine(requireExactlyOneField),
)

export type AllowedMcpServerEntry = z.infer<ReturnType<typeof AllowedMcpServerEntrySchema>>
export type DeniedMcpServerEntry = z.infer<ReturnType<typeof DeniedMcpServerEntrySchema>>

export function isMcpServerNameEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is AllowedMcpServerEntry & { serverName: string } {
  return typeof (entry as { serverName?: unknown }).serverName === 'string'
}

export function isMcpServerCommandEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is AllowedMcpServerEntry & { serverCommand: string[] } {
  return Array.isArray((entry as { serverCommand?: unknown }).serverCommand)
}

export function isMcpServerUrlEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is AllowedMcpServerEntry & { serverUrl: string } {
  return typeof (entry as { serverUrl?: unknown }).serverUrl === 'string'
}

export const PermissionsSchema = lazySchema(() =>
  z
    .object({
      allow: z.array(PermissionRuleSchema()).optional(),
      deny: z.array(PermissionRuleSchema()).optional(),
      ask: z.array(PermissionRuleSchema()).optional(),
      defaultMode: z
        .preprocess(
          v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
          z.enum(PERMISSION_MODES),
        )
        .optional(),
      disableBypassPermissionsMode: z.literal('disable').optional(),
      additionalDirectories: z.array(z.string()).optional(),
    })
    .passthrough(),
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

const userConfigValueSchema = (): z.ZodType =>
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])

export const ExtensionsSettingsSchema = lazySchema(() =>
  z.object({
    enabled: z.record(z.string(), z.boolean()).optional(),
    wanted: z
      .array(
        z.object({
          name: z.string(),
          source: z.string(),
          ref: z.string().optional(),
        }),
      )
      .optional(),
    blocked: z.array(z.string()).optional(),
    options: z.record(z.string(), z.record(z.string(), userConfigValueSchema())).optional(),
  }),
)
export type ExtensionsSettings = z.infer<ReturnType<typeof ExtensionsSettingsSchema>>

export const SettingsSchema = lazySchema(() => {
  const surfaces = CUSTOMIZATION_SURFACES as readonly string[]
  const base = z.object({
    $schema: z.string().optional(),

    apiKeyHelper: z.string().optional(),
    proxyAuthHelper: z.string().optional(),
    forceLoginMethod: z.enum(['claudeai', 'console']).optional(),
    forceLoginOrgUUID: z.string().optional(),

    fileSuggestion: z.object({ type: z.literal('command'), command: z.string() }).optional(),
    respectGitignore: z.boolean().optional(),
    cleanupPeriodDays: z.number().int().min(0).optional(),
    instructionExcludes: z.array(z.string()).optional().describe('Glob patterns or absolute paths of instruction files to skip (e.g. ~/.mercury/MERCURY.md or **/.mercury/rules/*.md); managed layers cannot be excluded'),
    plansDirectory: z.string().optional().describe('Project-root-relative directory for plan files (replacing the default plans/ directory under the Mercury config home)'),
    autoMemoryEnabled: z.boolean().optional(),
    autoMemoryDirectory: z.string().optional().describe('Where auto memory is written (default under the Mercury config home); ignored when set by checked-in project settings'),
    autoDreamEnabled: z.boolean().optional(),

    env: EnvironmentVariablesSchema().optional(),
    attribution: z.object({ commit: z.string().optional(), pr: z.string().optional() }).optional(),
    includeMercuryCoAuthor: z.boolean().optional(),
    includeGitInstructions: z.boolean().optional(),

    permissions: PermissionsSchema().optional(),

    model: z.string().optional(),
    availableModels: z.array(z.string()).optional(),
    modelOverrides: z.record(z.string(), z.string()).optional(),
    advisorModel: z.string().optional(),
    effortLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().catch(undefined),
    supercodeEffort: z.boolean().optional(),
    alwaysThinkingEnabled: z.boolean().optional(),

    enableAllProjectMcpServers: z.boolean().optional(),
    enabledMcpjsonServers: z.array(z.string()).optional(),
    disabledMcpjsonServers: z.array(z.string()).optional(),
    allowedMcpServers: z.array(AllowedMcpServerEntrySchema()).optional(),
    deniedMcpServers: z.array(DeniedMcpServerEntrySchema()).optional(),
    allowManagedMcpServersOnly: z.boolean().optional(),

    hooks: HooksSchema().optional(),
    disableAllHooks: z.boolean().optional(),
    allowManagedHooksOnly: z.boolean().optional(),
    allowedHttpHookUrls: z.array(z.string()).optional(),
    httpHookAllowedEnvVars: z.array(z.string()).optional(),
    allowManagedPermissionRulesOnly: z.boolean().optional(),

    extensions: ExtensionsSettingsSchema().optional(),
    strictExtensionOnlyCustomization: z
      .preprocess(
        value => {
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
        },
        z.union([z.boolean(), z.array(z.enum(CUSTOMIZATION_SURFACES))]),
      )
      .optional()
      .catch(undefined)
      .describe("Managed lock restricting customization surfaces to extensions (filesystem sources such as the config home's skills directory are skipped for locked surfaces)"),

    language: z.string().optional(),
    spinnerTipsEnabled: z.boolean().optional(),
    spinnerVerbs: z
      .object({ mode: z.enum(['append', 'replace']), verbs: z.array(z.string()) })
      .optional(),
    spinnerTipsOverride: z
      .object({ excludeDefault: z.boolean().optional(), tips: z.array(z.string()) })
      .optional(),
    syntaxHighlightingDisabled: z.boolean().optional(),
    terminalTitleFromRename: z.boolean().optional(),
    prefersReducedMotion: z.boolean().optional(),
    showThinkingSummaries: z.boolean().optional(),
    showClearContextOnPlanAccept: z.boolean().optional(),
    progressReporting: z.boolean().optional(),
    promptSuggestionEnabled: z.boolean().optional(),
    feedbackSurveyRate: z.number().min(0).max(1).optional(),
    companyAnnouncements: z.array(z.string()).optional(),
    agent: z.string().optional(),
    skipWebFetchPreflight: z.boolean().optional(),
    skipDangerousModePermissionPrompt: z.boolean().optional(),
    disableAutoMode: z.literal('disable').optional(),
    defaultShell: z.enum(['bash', 'powershell']).optional(),
    shellEngine: z.enum(['system', 'brush']).optional(),
    instructionProfile: z.enum(['auto', 'native']).optional(),
    channelsEnabled: z.boolean().optional(),
    apollo: z
      .object({
        preflightQuestions: z.number().int().min(1).max(20).optional(),
      })
      .optional()
      .describe('Apollo Mode: pre-flight interview poll budget (default 7)'),
    sandbox: SandboxSettingsSchema().optional(),
    worktree: z
      .object({
        symlinkDirectories: z.array(z.string()).optional(),
        sparsePaths: z.array(z.string()).optional(),
      })
      .optional(),
    remote: z.object({ defaultEnvironmentId: z.string().optional() }).optional(),
    sshConfigs: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          sshHost: z.string(),
          sshPort: z.number().optional(),
          sshIdentityFile: z.string().optional(),
          startDirectory: z.string().optional(),
        }),
      )
      .optional(),
    autoUpdatesChannel: z.enum(['latest', 'stable']).optional(),
    minimumVersion: z.string().optional(),
  })
  return base.passthrough()
})

export type SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>
