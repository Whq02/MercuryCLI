import { z } from 'zod/v4'

import { CompatProviderSchema } from './compatProvider.js'
import { ModelFactsSchema } from './modelFacts.js'
import { SandboxSettingsSchema } from '../../entrypoints/sandboxTypes.js'
import { EFFORT_LEVELS } from '../effortLadder.js'
import { HooksSchema } from '../../schemas/hooks.js'
import { lazySchema } from '../lazySchema.js'
import { PERMISSION_MODES } from '../permissions/PermissionMode.js'
import { PermissionRuleSchema } from './permissionValidation.js'
import type { HookEntry } from '../../schemas/hooks.js'

export { HookEntrySchema, HooksSchema } from '../../schemas/hooks.js'
export type { HookEntry, HooksSettings } from '../../schemas/hooks.js'

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
  hooks: HookEntry[]
  extensionName: string
  extensionRoot: string
  extensionId: string
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

export const SettingsSchema = lazySchema(() => {
  const base = z.object({
    $schema: z.string().optional(),
    models: ModelFactsSchema().optional().describe('Model facts keyed by the full id: contextWindow, maxOutputTokens, prices, efforts, images and reasoning; _default maps provider families to facts for unknown ids; recorded capabilities are never reduced'),
    compatProvider: CompatProviderSchema().optional().describe('Custom endpoints keyed by name, or one endpoint named default: baseUrl, label, models, headers, sessionAffinityHeader and dialect; keys are kept by /logins, not in settings'),
    credentials: z.object({
      keyCommand: z.string().optional(),
      keyCommands: z.record(z.string().min(1), z.string()).optional(),
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
      directory: z.string().optional().describe('Where memory is written (default under the Mercury config home); ignored when set by checked-in project settings'),
      embeddingModel: z.string().optional().describe('Which embedding model memory ranks recall by meaning with, beside the word match: a model name this install carries (the shipped default), or the path of a gguf file; a name or path that resolves nowhere leaves memory on word match only and the front page says so'),
      pinnedLimit: z.number().int().min(1000).optional().describe('How much pinned memory text (characters) loads into every session before Mercury says the shelf is full; every pinned rule still loads past it (default 8000)'),
      startLimit: z.number().int().min(1000).optional().describe('How much memory text (characters) rides at the start of a session beyond the pinned rules, which always ride whole: the facts and earlier notes most relevant to the branch, the files touched lately and the last note, until the allowance is used (default 4000); what is left out is a Recall away'),
      tellEngineSwitch: z.boolean().optional().describe('Tell the model when its engine is switched: with it on, one line reaches the model at the switch naming the new engine and the time; off (the default), a switch is invisible to the model — the /model rows stay your record, and the model learns its engine by reading mercury://seat'),
      journal: z.boolean().optional().describe("The session journal (default off): when `true`, at session end the model writes a brief entry — where the project is, the queued backlog, the operator's constraints — into a file in the Mercury home beside the project's memory, never under the project tree, never pushed, synced or shared by Mercury"),
      journalOnEntryPage: z.boolean().optional().describe("The journal's last entry on the entry page the model reads at session start (default off); what the model reads at entry travels to the engine's provider with the request — never uploaded means Mercury itself never pushes, syncs or shares the journal, not that the session's own engine does not see it"),
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
      backups: z.array(z.string()).optional().describe('The backup engines, in order: when the engine in use cannot answer a turn (its provider overloaded past the retry ladder, unreachable, refusing the sign-in after a refresh, or not serving the model), the turn hops to the first backup, then the next; a --backup-model heads the list; each engine is tried once per turn, and with no list nothing changes'),
      pins: z.record(z.string(), z.string()).optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
      sessionDefaults: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      usageNotice: z.boolean().optional().describe("Usage notice to the model — with it on, the model is told when the session's usage window or spending limit is near (80% and 90%); off, the model is told nothing and only you see the meters"),
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
      hooks: HooksSchema().optional().describe('The hooks, by event: one entry per hook with its own match; the Hooks page of the built-in docs defines the events and the entry — ask Mercury how hooks work (the mercury-docs skill reads docs/HOOKS.md, shipped inside Mercury)'),
      disabled: z.boolean().optional().describe('True turns off every hook that is not managed; in the managed layer, every hook'),
      managedOnly: z.boolean().optional().describe("True in the managed layer runs only the managed layer's hooks"),
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
      firstRunCards: z.enum(['centred', 'top-left']).optional().describe('Where the first-run cards sit: centred on the screen with the trust tone in brown (the default), or top-left with the amber tone'),
      ping: z.boolean().optional().describe('Ping the terminal once when a chat finishes its turn while you are away (an iTerm2 notification there, the bell elsewhere); on unless set to false'),
      accountIdentity: z.boolean().optional().describe('Account identity on the screens: shown unless set to false; hidden takes every signed-in address, username and key tail off the screens (for a recording) and leaves the account word, while the Logins screen, /accounts and the health report still name the account'),
      zen: z.boolean().optional().describe('Zen mode: true hides the lanes and vitals rails and the chat takes the full width of the terminal (the rail-less layout narrow terminals already get); off unless set to true; /zen flips it and the Zen mode row of /config shows it'),
    }).passthrough().optional(),
    context: z.object({ wayBack: z.boolean().optional() }).passthrough().optional(),
    input: z.object({ suggestions: z.boolean().optional() }).passthrough().optional(),
    shell: z.object({
      kind: z.enum(['bash', 'powershell']).optional(),
      engine: z.enum(['system', 'brush']).optional(),
      sessions: z.number().int().min(1).max(64).optional().describe("The ceiling on live shell-engine sessions Mercury keeps at once: the main conversation's own plus that many minus one for crewmates (default 8). A crewmate past the ceiling waits for a free session, never sharing another owner's; a ceiling of 1 leaves no session for crewmates"),
      filterOutput: z.boolean().optional().describe("Filter a shell command's output before the model reads it (default off): progress-bar redraws collapse to their last line, package-manager install chatter is dropped, a run of three or more identical lines folds to one with its count, and a footer names what was left out and the file holding the raw output; an output the filter would leave whole is unchanged"),
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
      openai: z.object({
        transport: z.enum(['http', 'websocket']).optional(),
      }).optional().describe('The OpenAI API-key road\'s transport: http (the default) posts every request; websocket keeps one connection per conversation and sends only the new input against the previous response, falling back to http on any connect or stream fault before the response begins'),
    }).passthrough().optional(),
    channels: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    apollo: z.object({ preflightQuestions: z.number().int().min(1).max(20).optional() }).optional().describe('Apollo Mode: pre-flight interview poll budget (default 7)'),
    workspace: z.object({
      worktree: z.object({
        symlinkDirectories: z.array(z.string()).optional(),
        sparsePaths: z.array(z.string()).optional(),
        prepare: z.string().optional().describe('A shell command run inside every new worktree after git makes it and before any seat uses it; a failure is named on the row'),
      }).optional(),
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
export type Settings = z.infer<ReturnType<typeof SettingsSchema>>

export type SettingsJson = z.infer<z.ZodObject<ReturnType<typeof SettingsSchema>['shape']>>
