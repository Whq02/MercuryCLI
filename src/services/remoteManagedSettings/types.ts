import { z } from 'zod'

import type { SettingsJson } from '../../utils/settings/types.js'

let schema: ReturnType<typeof buildSchema> | null = null

function buildSchema() {
  return z.object({
    uuid: z.string(),
    checksum: z.string(),
    settings: z.record(z.string(), z.unknown()),
  })
}

export function RemoteManagedSettingsResponseSchema(): ReturnType<typeof buildSchema> {
  if (schema === null) schema = buildSchema()
  return schema
}

export type RemoteManagedSettingsResponse = z.infer<ReturnType<typeof buildSchema>>

export type RemoteManagedSettingsFetchResult = {
  success: boolean
  settings?: SettingsJson | null
  checksum?: string
  error?: string
  skipRetry?: boolean
}
