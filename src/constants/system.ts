import { flagEnv } from '../substrate/flagRegistry.js'
import { getWorkload } from '../utils/workloadContext.js'
import { logForDebugging } from '../utils/debug.js'
import { getAnthropicClientContractVersion } from './oauth.js'

const ATTESTATION_PLACEHOLDER = ''

export function getAttributionHeader(fingerprint: string): string {
  const entrypoint = flagEnv('MERCURY_ENTRYPOINT') || 'unknown'
  const workload = getWorkload()
  const workloadPart = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${getAnthropicClientContractVersion()}.${fingerprint};cc_entrypoint=${entrypoint};${ATTESTATION_PLACEHOLDER}${workloadPart}`
  logForDebugging(`attribution header: ${header}`)
  return header
}
