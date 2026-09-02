// ============================================================================
//  src/schemas/hooks.ts — the settings-file hook declaration schema.
//
//  Validates what users write in settings files and skill frontmatter; every
//  key name here is CONTRACT DATA (docs/COMPATIBILITY.md, settings-file hook
//  format). This module exists purely to break the import cycle between the
//  settings types and the extension manifest schema — both import from here.
//
//  All schemas are LAZILY constructed (first use, not module evaluation):
//  a startup-cost and cycle-safety requirement, not a style choice.
// ============================================================================
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { SHELL_TYPES } from '../utils/shell/shellProvider.js'
import { HOOK_EVENTS, type HookEvent } from '../entrypoints/agentSdkTypes.js'

/**
 * The shared `if` condition: permission-rule syntax (a tool name with an
 * optional parenthesised pattern) evaluated against the hook input's tool
 * name and tool input. A hook whose condition does not match is skipped —
 * never spawned. Built once, reused by all four kinds.
 */
const ifSchema = lazySchema(() =>
  z
    .string()
    .optional()
    .describe(
      'Condition in permission-rule syntax (tool name with an optional parenthesised pattern). The hook runs only when it matches the hook input.',
    ),
)

/** Optional positive timeout, in SECONDS (not milliseconds). Capped at the
 *  32-bit timer bound (2147483s): past it the seconds-to-ms product
 *  overflowed setTimeout to ~1ms — the hook was killed instantly and the
 *  outcome misreported (FC-032). The FC-004 salvage prunes a beyond-bound
 *  value as a LEAF, so the hook survives on its default clock. */
const timeoutSchema = lazySchema(() =>
  z
    .number()
    .positive()
    .max(2_147_483, 'timeout must be at most 2147483 seconds (the runtime timer bound)')
    .optional()
    .describe('Timeout for this hook, in seconds.'),
)

/**
 * One shared factory produces the four member schemas: the discriminator,
 * the kind-specific fields, then the fields every kind carries.
 */
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

// HARD CONSTRAINT: the agent prompt stays a plain string with NO transform.
// Settings updates round-trip the parsed result through JSON serialisation;
// a transformed function value is silently dropped, which DELETES the
// user's prompt from their settings file (a known data-loss defect).
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

/** The four hook kinds, discriminated on `type`, in declaration order. */
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

/** A matcher: an optional pattern (typically over tool names) plus hooks.
 *  STRICT and compilability-checked, with every issue attached to the ENTRY
 *  (not a leaf) — the FC-004 salvage then prunes the WHOLE entry, because a
 *  pruned `matcher` leaf would widen a scoped hook into a silent
 *  match-everything hook: a typo'd `mather` key did exactly that (FC-034),
 *  and an uncompilable regex was accepted with zero errors and disabled the
 *  hook forever at fire time (FC-033). A DELIBERATELY absent matcher stays
 *  legal. */
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

/** Hooks settings: a partial record from hook-event name to matchers. */
export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)

// Written by hand rather than inferred: the inferred form would drag the
// schema's optionality into every consumer.
export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>

