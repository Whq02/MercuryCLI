import type { RunpodClient } from '../runpod.js'

export type { HostOffer, HostPod } from '../runpod.js'
export const HOST_VENDOR_INFO = {
  runpod: { label: 'Runpod', keyHelp: 'Create a Runpod API key at https://www.runpod.io/console/user/settings.' },
  vast: { label: 'Vast.ai', keyHelp: 'Create a Vast.ai API key at https://cloud.vast.ai/manage-keys/.' },
  lambda: { label: 'Lambda', keyHelp: 'Create a Lambda Cloud API key at https://cloud.lambda.ai/api-keys.' },
} as const
export interface HostVendor extends Pick<RunpodClient, 'offers' | 'watchOffer' | 'create' | 'pods' | 'get' | 'stop' | 'terminate' | 'logs' | 'rateLimitPolicy' | 'shapes'> {
  readonly vendor: 'runpod' | 'vast' | 'lambda'
  readonly label: string
  readonly keyHelp: string
  readonly capabilities: { readonly stop: boolean; readonly dataCenters: boolean; readonly persistentDisk: 'volume' | 'root' | 'filesystem' }
  offersNote(): string
}

export function runpodVendor(client: RunpodClient): HostVendor {
  return {
    vendor: 'runpod', ...HOST_VENDOR_INFO.runpod,
    capabilities: { stop: true, dataCenters: true, persistentDisk: 'volume' },
    offers: client.offers.bind(client), watchOffer: client.watchOffer.bind(client), create: client.create.bind(client),
    pods: client.pods.bind(client), get: client.get.bind(client), stop: client.stop.bind(client), terminate: client.terminate.bind(client),
    logs: client.logs.bind(client), rateLimitPolicy: client.rateLimitPolicy.bind(client), shapes: client.shapes.bind(client), offersNote: () => '',
  }
}
