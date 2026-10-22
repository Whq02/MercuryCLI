import { readStoredRunpodApiKey, readStoredVastApiKey, readStoredLambdaApiKey, writeStoredRunpodApiKey, writeStoredVastApiKey, writeStoredLambdaApiKey } from '../../providers/providerSecrets.js'
import { RunpodClient } from '../runpod.js'
import type { HostRecord } from '../store.js'
import { HOST_VENDOR_INFO, runpodVendor, type HostVendor } from './vendor.js'
import { VastClient, VAST_STORAGE_NOTICE, VAST_KEY_NOTICE } from './vast.js'
import { LambdaClient, LAMBDA_STORAGE_NOTICE, LAMBDA_KEY_NOTICE } from './lambda.js'

export type HostVendorId = HostVendor['vendor']
export const HOST_VENDORS: readonly HostVendorId[] = ['runpod', 'vast', 'lambda']
export const vendorLabel = (vendor: HostVendorId): string => HOST_VENDOR_INFO[vendor].label
export const vendorKey = (vendor: HostVendorId): string | undefined => ({ runpod: readStoredRunpodApiKey, vast: readStoredVastApiKey, lambda: readStoredLambdaApiKey })[vendor]()
export const saveVendorKey = (vendor: HostVendorId, key: string): void => ({ runpod: writeStoredRunpodApiKey, vast: writeStoredVastApiKey, lambda: writeStoredLambdaApiKey })[vendor](key)
export const vendorStorage = (vendor: HostVendorId): string => vendor === 'vast' ? VAST_STORAGE_NOTICE : vendor === 'lambda' ? LAMBDA_STORAGE_NOTICE : 'Stop keeps the volume disk and its storage bill; terminate deletes the pod’s volume disk. Attached weights disks bill separately.'
export const vendorKeyNotice = (vendor: HostVendorId): string => vendor === 'vast' ? VAST_KEY_NOTICE : vendor === 'lambda' ? LAMBDA_KEY_NOTICE : 'The public key is injected into this pod only; the private key stays in Mercury.'
const runpodClients = new WeakMap<HostVendor, RunpodClient>()
export function vendorClient(record: Pick<HostRecord, 'vendor' | 'apiBaseUrl'> | HostVendorId = 'runpod', options: { key?: string; apiBaseUrl?: string } = {}): HostVendor {
  const vendor = typeof record === 'string' ? record : record.vendor ?? 'runpod'
  const key = options.key ?? vendorKey(vendor)
  if (!key) throw new Error('The saved ' + vendorLabel(vendor) + ' key is unavailable. Connect ' + vendorLabel(vendor) + ' from /llmhost.')
  const base = options.apiBaseUrl ?? (typeof record === 'string' ? undefined : record.apiBaseUrl)
  if (vendor === 'vast') return new VastClient(key, base)
  if (vendor === 'lambda') return new LambdaClient(key, base)
  const raw = new RunpodClient(key, base)
  const client = runpodVendor(raw)
  runpodClients.set(client, raw)
  return client
}
export function runpodOnly(client: HostVendor | RunpodClient, feature: string): RunpodClient {
  if (client instanceof RunpodClient) return client
  const raw = runpodClients.get(client)
  if (!raw) throw new Error(feature + ' is Runpod-only; ' + client.label + ' does not offer it. Nothing was changed.')
  return raw
}
