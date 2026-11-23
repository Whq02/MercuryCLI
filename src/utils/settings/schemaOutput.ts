import { toJSONSchema } from 'zod/v4'

import { jsonStringify } from '../slowOperations.js'
import { SettingsSchema } from './types.js'

export function generateSettingsJSONSchema(): string {
  return jsonStringify(toJSONSchema(SettingsSchema(), { unrepresentable: 'any' }), null, 2)
}
