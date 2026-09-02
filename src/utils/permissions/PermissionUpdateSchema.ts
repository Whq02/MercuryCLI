import { z } from 'zod/v4'

import { decodePermissionModeSpelling } from '../../types/permissions.js'

export type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from '../../types/permissions.js'

export function permissionUpdateDestinationSchema() {
  return z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'])
}

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
