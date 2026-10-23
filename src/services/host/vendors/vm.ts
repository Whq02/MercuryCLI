import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { HostOffer, HostPod } from './vendor.js'
import { isOpenSshKey, keyMaterial, type VendorTiming } from './http.js'
import { HostTerminationUnconfirmed, type HostReadOnly } from '../retry.js'

export const vmKeyName = (publicKey: string): string => 'mercury-host-' + createHash('sha256').update(keyMaterial(publicKey)).digest('hex').slice(0, 16)
export const sortVmOffers = (a: HostOffer, b: HostOffer): number => Number(a.recipe.verified.by === 'unverified') - Number(b.recipe.verified.by === 'unverified') || a.price - b.price || a.recipe.id.localeCompare(b.recipe.id) || (a.dataCenter ?? '').localeCompare(b.dataCenter ?? '')
export function validateVmCreate(publicKey: string, name: string, limit = 63): void {
  if (!isOpenSshKey(publicKey) || publicKey.trim().length > 4096) throw new Error('One OpenSSH public key of 4096 characters or fewer is required; nothing was rented.')
  if (!new RegExp('^[a-zA-Z0-9][a-zA-Z0-9-]{0,' + (limit - 1) + '}$').test(name)) throw new Error('Instance names need letters, digits or hyphens, at most ' + limit + ' characters; nothing was rented.')
}
export class VmPlacements<T> {
  private rows = new WeakMap<HostOffer, { value: T; fingerprint: string }>()
  add(offer: HostOffer, value: T): void { this.rows.set(offer, { value, fingerprint: JSON.stringify(offer) }) }
  get(offer: HostOffer): T {
    const row = this.rows.get(offer)
    if (!row || row.fingerprint !== JSON.stringify(offer)) throw new Error('Choose an unchanged regional offer returned by this client before renting.')
    return row.value
  }
}
export async function verifyVmAbsent(label: string, id: string, list: (signal?: AbortSignal) => Promise<HostPod[]>, timing: VendorTiming, readOnly?: HostReadOnly, storageGone?: (signal?: AbortSignal) => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + (timing.readyTimeoutMs ?? 120000)
  let last = ''
  for (;;) {
    try {
      const absent = !(await (readOnly ? readOnly('instance listing', list) : list())).some(row => row.id === id)
      if (absent && (!storageGone || await (readOnly ? readOnly('storage listing', storageGone) : storageGone()))) return
    } catch (error) {
      if (readOnly) throw new HostTerminationUnconfirmed(label, error)
      last = ' ' + (error instanceof Error ? error.message : String(error))
    }
    if (Date.now() >= deadline) throw new Error(label + ' termination is not verified; the instance or its storage may still bill. Check the console.' + last)
    await delay(timing.pollMs ?? 2000)
  }
}
