import type { RunpodClient } from '../runpod.js'
import type { HostReadOnly } from '../retry.js'

export type { HostOffer, HostPod } from '../runpod.js'
type HostVendorInfo = { readonly label: string; readonly keyHelp: string }
export const HOST_VENDOR_INFO: Readonly<Record<'runpod' | 'vast' | 'lambda' | 'huggingface' | 'hyperstack' | 'verda' | 'digitalocean', HostVendorInfo>> = {
  runpod: { label: 'Runpod', keyHelp: 'Create a Runpod API key at https://console.runpod.io/user/credentials (Credentials → API Keys).' },
  vast: { label: 'Vast.ai', keyHelp: 'Create a Vast.ai API key at https://cloud.vast.ai/manage-keys/.' },
  lambda: { label: 'Lambda', keyHelp: 'Create a Lambda Cloud API key at https://cloud.lambda.ai/api-keys.' },
  huggingface: { label: 'Hugging Face', keyHelp: 'Use the Hugging Face account saved by /logins huggingface, with Inference Endpoints management permission.' },
  hyperstack: { label: 'Hyperstack', keyHelp: 'Create a key at https://console.hyperstack.cloud/api-keys. Renting registers Mercury’s SSH public key in the selected environment. Initial new-account quotas are not published; check the console.' },
  verda: { label: 'Verda', keyHelp: 'In https://console.verda.com, open API Credentials and paste Client ID:Client Secret here. Initial new-account quotas are not published; check the console. Network egress price is not published.' },
  digitalocean: { label: 'DigitalOcean', keyHelp: 'Create a token at https://cloud.digitalocean.com/account/api/tokens with Droplet, size, image, region and SSH-key access. Initial new-account quotas are not published; check the console.' },
}
export interface HostVendor extends Pick<RunpodClient, 'offers' | 'watchOffer' | 'create' | 'pods' | 'get' | 'stop' | 'logs' | 'rateLimitPolicy' | 'shapes'> {
  terminate(id: string, readOnly?: HostReadOnly): Promise<void>
  readonly vendor: keyof typeof HOST_VENDOR_INFO
  readonly label: string
  readonly keyHelp: string
  readonly capabilities: { readonly stop: boolean; readonly dataCenters: boolean; readonly persistentDisk: 'volume' | 'root' | 'filesystem' | 'none'; readonly managed?: boolean; readonly vm?: boolean }
  managedEndpoint?(id: string, signal?: AbortSignal): Promise<{ pod: import('../runpod.js').HostPod; baseUrl?: string }>
  resume?(id: string): Promise<import('../runpod.js').HostPod>
  offersNote(): string
}

export function runpodVendor(client: RunpodClient): HostVendor {
  return {
    vendor: 'runpod', label: HOST_VENDOR_INFO.runpod.label, keyHelp: HOST_VENDOR_INFO.runpod.keyHelp,
    capabilities: { stop: true, dataCenters: true, persistentDisk: 'volume' },
    offers: client.offers.bind(client), watchOffer: client.watchOffer.bind(client), create: client.create.bind(client),
    pods: client.pods.bind(client), get: client.get.bind(client), stop: client.stop.bind(client), terminate: client.terminate.bind(client),
    logs: client.logs.bind(client), rateLimitPolicy: client.rateLimitPolicy.bind(client), shapes: client.shapes.bind(client), offersNote: () => '',
  }
}
