import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { SHELL_TYPES } from '../utils/shell/shellProvider.js'
import { HOOK_EVENTS, type HookEvent } from '../entrypoints/agentSdkTypes.js'

const ifSchema = lazySchema(() =>
  z
    .string()
    .optional()
    .describe(
      'Condition in permission-rule syntax (tool name with an optional parenthesised pattern). The hook runs only when it matches the hook input.',
    ),
)

const timeoutSchema = lazySchema(() =>
  z
    .number()
    .positive()
    .max(2_147_483, 'timeout must be at most 2147483 seconds (the runtime timer bound)')
    .optional()
    .describe('Timeout for this hook, in seconds.'),
)

function hookKindSchema<
  const TType extends string,
  TFields extends Record<string, z.ZodType>,
>(type: TType, fields: TFields) {
  return z.object({
    type: z.literal(type),
    ...fields,
    if: ifSchema(),
    timeout: timeoutSchema(),
    statusMessage: z
      .string()
      .optional()
      .describe('Message shown in the spinner while the hook runs.'),
    once: z
      .boolean()
      .optional()
      .describe('Run this hook once, then remove it.'),
  })
}

const bashCommandHookSchema = lazySchema(() =>
  hookKindSchema('command', {
    command: z.string().describe('The shell command to execute.'),
    shell: z
      .enum(SHELL_TYPES)
      .optional()
      .describe(
        "Shell to run the command with: 'bash' uses your login shell family; 'powershell' uses pwsh. Defaults to bash.",
      ),
    async: z
      .boolean()
      .optional()
      .describe('Run in the background without blocking.'),
    asyncRewake: z
      .boolean()
      .optional()
      .describe(
        'Run in the background and wake the model when the hook exits with the blocking-error status. Implies async.',
      ),
  }),
)

const promptHookSchema = lazySchema(() =>
  hookKindSchema('prompt', {
    prompt: z
      .string()
      .describe(
        'Prompt evaluated by a model. An $ARGUMENTS placeholder receives the hook input JSON.',
      ),
    model: z
      .string()
      .optional()
      .describe('Model to evaluate the prompt with. Defaults to the default small fast model.'),
  }),
)

const agentHookSchema = lazySchema(() =>
  hookKindSchema('agent', {
    prompt: z
      .string()
      .describe(
        'What the agent should verify. An $ARGUMENTS placeholder receives the hook input JSON. Timeout defaults to 60 seconds.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Model for the agent. Defaults to the default small fast model floored to the mid-tier model — agent hooks never run the smallest model.',
      ),
  }),
)

const httpHookSchema = lazySchema(() =>
  hookKindSchema('http', {
    url: z
      .string()
      .url()
      .describe('URL that receives a POST of the hook input JSON.'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Request headers. Values may reference environment variables as $VAR or ${VAR}; only variables named in allowedEnvVars are interpolated.',
      ),
    allowedEnvVars: z
      .array(z.string())
      .optional()
      .describe(
        'Environment variable names allowed in header interpolation. Required for any interpolation; unlisted references resolve to empty strings.',
      ),
  }),
)

export const HookCommandSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    bashCommandHookSchema(),
    promptHookSchema(),
    agentHookSchema(),
    httpHookSchema(),
  ]),
)

export type HookCommand = z.infer<ReturnType<typeof HookCommandSchema>>
export type BashCommandHook = Extract<HookCommand, { type: 'command' }>
export type PromptHook = Extract<HookCommand, { type: 'prompt' }>
export type AgentHook = Extract<HookCommand, { type: 'agent' }>
export type HttpHook = Extract<HookCommand, { type: 'http' }>

export const HookMatcherSchema = lazySchema(() =>
  z
    .strictObject({
      matcher: z
        .string()
        .optional()
        .describe('Pattern matched against event-related values, typically tool names.'),
      hooks: z.array(HookCommandSchema()),
    })
    .superRefine((entry, ctx) => {
      if (entry.matcher === undefined) return
      try {
        new RegExp(entry.matcher)
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `matcher is not a valid regular expression: ${JSON.stringify(entry.matcher)}`,
        })
      }
    }),
)

export type HookMatcher = z.infer<ReturnType<typeof HookMatcherSchema>>

export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)

export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>
