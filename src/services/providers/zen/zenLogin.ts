import { errorMessageWithCause } from '../../../utils/errors.js'
import { writeStoredZenApiKey } from '../../../utils/router/providerSecrets.js'
import { ZEN_ENV_KEY, ZEN_KEY_PAGE } from './zenAccounts.js'
import { fetchZenGoUsage, zenGoWindowLine } from './zenUsageState.js'

export interface ZenKeyLoginOutcome {
  ok: boolean
  stored: boolean
  receipt: string
}

export const ZEN_KEY_RECEIPT_TAIL = 'Requests use opencode.ai/zen at the vendor\'s pay-as-you-go prices; the balance and auto-reload live in the console.'

export async function storeZenApiKeyLogin(key: string, io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number }): Promise<ZenKeyLoginOutcome> {
  key = key.trim()
  if (!key) return { ok: false, stored: false, receipt: 'Paste a non-empty OpenCode Zen API key.' }
  const env = io?.env ?? process.env
  const safe = (message: string): string => message.split(key).join('[redacted]')
  const probe = await fetchZenGoUsage(key, io)
  let note: string
  switch (probe.state) {
    case 'refused':
      if (probe.status === 401) {
        return { ok: false, stored: false, receipt: `OpenCode Zen refused this key (HTTP 401${probe.message ? `, ${probe.message}` : ''}) — nothing stored; create a key at ${ZEN_KEY_PAGE} and paste again.` }
      }
      note = `UNVERIFIED — the usage read answered HTTP ${probe.status}; the first turn proves the key`
      break
    case 'no-plan':
      note = 'key accepted · no OpenCode Go plan — turns draw the pay-as-you-go balance'
      break
    case 'confirmed':
      note = `key accepted · OpenCode Go plan · ${probe.usage.windows.map(zenGoWindowLine).join(' · ')}`
      break
    case 'invalid':
      note = 'key accepted · the usage read returned an unrecognised response'
      break
    case 'unreachable':
      note = `UNVERIFIED — the usage read could not confirm the key (${safe(probe.message)}); the first turn proves it`
      break
  }
  try {
    writeStoredZenApiKey(key)
  } catch (error) {
    return { ok: false, stored: false, receipt: `Could not store the key: ${safe(errorMessageWithCause(error))}` }
  }
  const shadow = env[ZEN_ENV_KEY]?.trim() ? ` NOTE: ${ZEN_ENV_KEY} is set and wins over this stored key.` : ''
  return { ok: true, stored: true, receipt: `OpenCode Zen API key stored (auth-scoped, mode 600) · ${note}. ${ZEN_KEY_RECEIPT_TAIL}${shadow}` }
}
