import { readStoredRunpodApiKey, readStoredVastApiKey, readStoredLambdaApiKey, writeStoredRunpodApiKey, writeStoredVastApiKey, writeStoredLambdaApiKey } from '../../providers/providerSecrets.js'
import { readStoredHyperstackApiKey, writeStoredHyperstackApiKey, readStoredVerdaApiKey, writeStoredVerdaApiKey, readStoredDigitaloceanApiKey, writeStoredDigitaloceanApiKey } from '../../providers/providerSecrets.js'
import { HyperstackClient, HYPERSTACK_STORAGE_NOTICE, HYPERSTACK_KEY_NOTICE } from './hyperstack.js'
import { VerdaClient, VERDA_STORAGE_NOTICE, VERDA_KEY_NOTICE } from './verda.js'
import { DigitalOceanClient, DIGITALOCEAN_STORAGE_NOTICE, DIGITALOCEAN_KEY_NOTICE } from './digitalocean.js'
import { RunpodClient } from '../runpod.js'
import type { HostRecord } from '../store.js'
import { HOST_VENDOR_INFO, runpodVendor, type HostVendor } from './vendor.js'
import { VastClient, VAST_STORAGE_NOTICE, VAST_KEY_NOTICE } from './vast.js'
import { LambdaClient, LAMBDA_STORAGE_NOTICE, LAMBDA_KEY_NOTICE } from './lambda.js'
import { HuggingfaceClient, HF_ENDPOINTS_STORAGE_NOTICE, HF_ENDPOINTS_KEY_NOTICE } from './huggingface.js'
import { resolveHuggingfaceApiKey } from '../../providers/huggingface/huggingfaceAccounts.js'
import { hostHuggingfaceCredential, hostHuggingfaceDispatchCredential } from '../jobCredentials.js'

export type HostVendorId = HostVendor['vendor']
export const HOST_VENDORS: readonly HostVendorId[] = ['runpod', 'vast', 'lambda', 'huggingface', 'hyperstack', 'verda', 'digitalocean']
export const vendorLabel = (vendor: HostVendorId): string => HOST_VENDOR_INFO[vendor].label
export const vendorKey = (vendor: HostVendorId): string | undefined => vendor === 'huggingface' ? resolveHuggingfaceApiKey()?.key : ({ runpod: readStoredRunpodApiKey, vast: readStoredVastApiKey, lambda: readStoredLambdaApiKey, hyperstack: readStoredHyperstackApiKey, verda: readStoredVerdaApiKey, digitalocean: readStoredDigitaloceanApiKey })[vendor]()
export const saveVendorKey = (vendor: HostVendorId, key: string | null): void => {
  if (vendor === 'huggingface') throw new Error('Hugging Face uses the existing /logins huggingface sign-in.')
  ;({ runpod: writeStoredRunpodApiKey, vast: writeStoredVastApiKey, lambda: writeStoredLambdaApiKey, hyperstack: writeStoredHyperstackApiKey, verda: writeStoredVerdaApiKey, digitalocean: writeStoredDigitaloceanApiKey })[vendor](key)
}
export const vendorStorage = (vendor: HostVendorId): string => vendor === 'hyperstack' ? HYPERSTACK_STORAGE_NOTICE : vendor === 'verda' ? VERDA_STORAGE_NOTICE : vendor === 'digitalocean' ? DIGITALOCEAN_STORAGE_NOTICE : vendor === 'huggingface' ? HF_ENDPOINTS_STORAGE_NOTICE : vendor === 'vast' ? VAST_STORAGE_NOTICE : vendor === 'lambda' ? LAMBDA_STORAGE_NOTICE : 'Stop keeps the volume disk and its storage bill; terminate deletes the pod’s volume disk. Attached weights disks bill separately.'
export const vendorKeyNotice = (vendor: HostVendorId): string => vendor === 'hyperstack' ? HYPERSTACK_KEY_NOTICE : vendor === 'verda' ? VERDA_KEY_NOTICE : vendor === 'digitalocean' ? DIGITALOCEAN_KEY_NOTICE : vendor === 'huggingface' ? HF_ENDPOINTS_KEY_NOTICE : vendor === 'vast' ? VAST_KEY_NOTICE : vendor === 'lambda' ? LAMBDA_KEY_NOTICE : 'Mercury’s SSH key is added to this pod only, never to your Runpod account.'
const runpodClients = new WeakMap<HostVendor, RunpodClient>()
const recordKey = (record: Pick<HostRecord, 'vendor' | 'apiBaseUrl' | 'id' | 'huggingfaceCredential'>, vendor: HostVendorId): string | undefined => {
  if (vendor !== 'huggingface') return vendorKey(vendor)
  try { return hostHuggingfaceCredential(record)?.key } catch { return undefined }
}
export function vendorClient(record: Pick<HostRecord, 'vendor' | 'apiBaseUrl' | 'id' | 'huggingfaceCredential'> | HostVendorId = 'runpod', options: { key?: string; apiBaseUrl?: string } = {}): HostVendor {
  const vendor = typeof record === 'string' ? record : record.vendor ?? 'runpod'
  const key = options.key ?? (typeof record === 'string' ? vendorKey(vendor) : recordKey(record, vendor))
  if (!key) throw new Error('The saved ' + vendorLabel(vendor) + ' key is unavailable. Connect ' + vendorLabel(vendor) + ' from /llmhost.')
  const base = options.apiBaseUrl ?? (typeof record === 'string' ? undefined : record.apiBaseUrl)
  if (vendor === 'vast') return new VastClient(key, base)
  if (vendor === 'lambda') return new LambdaClient(key, base)
  if (vendor === 'hyperstack') return new HyperstackClient(key, base)
  if (vendor === 'verda') return new VerdaClient(key, base)
  if (vendor === 'digitalocean') return new DigitalOceanClient(key, base)
  if (vendor === 'huggingface') {
    const saved = typeof record === 'string' ? vendorKey(vendor) : recordKey(record, vendor)
    return new HuggingfaceClient(key, base, {}, !options.key || options.key === saved ? refresh => hostHuggingfaceDispatchCredential(typeof record === 'string' ? undefined : record, refresh) : undefined)
  }
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
