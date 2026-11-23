import { toJSONSchema } from 'zod/v4'

import { jsonStringify } from '../logs/slowOperations.js'
import { SettingsSchema } from './settingsSchema.js'

export function generateSettingsJSONSchema(): string {
  return jsonStringify(toJSONSchema(SettingsSchema(), { unrepresentable: 'any' }), null, 2)
}
