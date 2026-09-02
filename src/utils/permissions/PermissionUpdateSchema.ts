/**
 * Zod discriminated-union schema for permission updates and their
 * destinations. Deliberately dependency-light so the hooks type module can
 * import it without a cycle.
 */
import { z } from 'zod/v4'

import { decodePermissionModeSpelling } from '../../types/permissions.js'

export type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from '../../types/permissions.js'

/** Lazy zod enum over the five update destinations. */
export function permissionUpdateDestinationSchema() {
  return z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'])
}

/** Lazy zod discriminated union over the six update variants, keyed on `type`. */
export function permissionUpdateSchema() {
  const destination = permissionUpdateDestinationSchema()
  const behavior = z.enum(['allow', 'deny', 'ask'])
  const ruleValue = z.object({ toolName: z.string(), ruleContent: z.string().optional() })
  return z.discriminatedUnion('type', [
    z.object({ type: z.literal('addRules'), rules: z.array(ruleValue), behavior, destination }),
    z.object({ type: z.literal('replaceRules'), rules: z.array(ruleValue), behavior, destination }),
    z.object({ type: z.literal('removeRules'), rules: z.array(ruleValue), behavior, destination }),
    z.object({
      type: z.literal('setMode'),
      // setMode accepts only the external mode set (explicit literals so the
      // inferred type is the external-mode union, not a widened string).
      // Retired Claude-Code spellings decode through the bounded alias BEFORE
      // validation — SDK callers and persisted updates keep working, as the
      // new ids.
      mode: z.preprocess(
        v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
        z.enum(['default', 'dontAsk', 'implement', 'sovereign', 'strategy']),
      ),
      destination,
    }),
    z.object({ type: z.literal('addDirectories'), directories: z.array(z.string()), destination }),
    z.object({ type: z.literal('removeDirectories'), directories: z.array(z.string()), destination }),
  ])
}
