import { RunpodClient } from '../runpod.js'
import type { HostVendor } from './vendor.js'

export const runpodClients = new WeakMap<HostVendor, RunpodClient>()
export function runpodOnly(client: HostVendor | RunpodClient, feature: string): RunpodClient {
  if (client instanceof RunpodClient) return client
  const raw = runpodClients.get(client)
  if (!raw) throw new Error(feature + ' is Runpod-only; ' + client.label + ' does not offer it. Nothing was changed.')
  return raw
}
