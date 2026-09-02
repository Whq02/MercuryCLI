/**
 * The remote managed-settings endpoint contract: the 200 response envelope
 * and the fetch-result shape.
 */
import { z } from 'zod'

import type { SettingsJson } from '../../utils/settings/types.js'

/** Lazy singleton — built on first call. */
let schema: ReturnType<typeof buildSchema> | null = null

function buildSchema() {
  return z.object({
    uuid: z.string(),
    checksum: z.string(),
    settings: z.record(z.string(), z.unknown()),
  })
}

/** The 200 response envelope: `{ uuid, checksum, settings }`. */
export function RemoteManagedSettingsResponseSchema(): ReturnType<typeof buildSchema> {
  if (schema === null) schema = buildSchema()
  return schema
}

export type RemoteManagedSettingsResponse = z.infer<ReturnType<typeof buildSchema>>

/** One fetch attempt's outcome. `settings: null` means not-modified (304). */
export type RemoteManagedSettingsFetchResult = {
  success: boolean
  settings?: SettingsJson | null
  checksum?: string
  error?: string
  skipRetry?: boolean
}
