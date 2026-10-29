import { getWorkload } from '../utils/workloadContext.js'
import { logForDebugging } from '../utils/debug.js'
import { getAnthropicClientContractVersion } from './oauth.js'

const ATTESTATION_PLACEHOLDER = ''

export function getAttributionHeader(fingerprint: string): string {

  const version = getAnthropicClientContractVersion()
  const entrypoint = process.env.MERCURY_ENTRYPOINT || 'unknown'
  const workload = getWorkload()
  const value = `cc_version=${version}.${fingerprint};cc_entrypoint=${entrypoint};${ATTESTATION_PLACEHOLDER}${
    workload ? ` cc_workload=${workload};` : ''
  }`
  const header = `x-anthropic-billing-header: ${value}`
  logForDebugging(`attribution header: ${header}`)
  return header
}
