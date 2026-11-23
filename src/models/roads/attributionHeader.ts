import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getWorkload } from './workloadContext.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getAnthropicClientContractVersion } from '../sign-in/oauth/oauth.js'

const ATTESTATION_PLACEHOLDER = ''

export function getAttributionHeader(fingerprint: string): string {
  const entrypoint = flagEnv('MERCURY_ENTRYPOINT') || 'unknown'
  const workload = getWorkload()
  const workloadPart = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${getAnthropicClientContractVersion()}.${fingerprint};cc_entrypoint=${entrypoint};${ATTESTATION_PLACEHOLDER}${workloadPart}`
  logForDebugging(`attribution header: ${header}`)
  return header
}
