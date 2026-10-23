import type { LlmHostRoad } from '../llmHost/index.js'
import { HOST_VENDORS, saveVendorKey, vendorClient, vendorKey, vendorLabel, type HostVendorId } from './vendors/client.js'
import { HOST_VENDOR_INFO } from './vendors/vendor.js'

export const vendorKeyRows = (): { value: string; label: string }[] => HOST_VENDORS.filter(id => vendorKey(id)).map(id => ({ value: 'key:' + id, label: vendorLabel(id) + (id === 'huggingface' ? ' · Sign out with /logins huggingface' : ' · Replace key / Remove key') }))
export async function manageVendorKey(vendor: HostVendorId, ask: Parameters<LlmHostRoad>[0], emit: Parameters<LlmHostRoad>[1], signal: AbortSignal, options: { apiBaseUrl?: string; changed?: () => void } = {}): Promise<boolean> {
  if (vendor === 'huggingface') {
    emit({ title: vendorLabel(vendor), words: 'Sign out with /logins huggingface. Existing endpoints keep billing until paused or deleted.' })
    return false
  }
  const choice = await ask({ step: 'host-key-manage', title: vendorLabel(vendor) + ' API key', found: 'Manage the saved key. Removing it does not stop rented machines or their bills.', willRun: '', rows: [{ value: 'replace', label: 'Replace key' }, { value: 'remove', label: 'Remove key' }, { value: 'cancel', label: 'Cancel' }] })
  if (signal.aborted) return false
  if (choice === 'remove') {
    const confirm = await ask({ step: 'host-key-remove', title: 'Remove key — ' + vendorLabel(vendor), found: 'Rented machines and disks keep billing. You can connect again to manage them.', willRun: 'Only the saved key is removed; nothing is stopped or deleted at the provider.', rows: [{ value: 'remove', label: 'Remove key' }, { value: 'cancel', label: 'Cancel' }] })
    if (confirm !== 'remove' || signal.aborted) return false
    saveVendorKey(vendor, null)
    options.changed?.()
    return true
  }
  if (choice !== 'replace') return false
  const entered = await ask({ step: vendor + '-key', title: vendorLabel(vendor) + ' API key', found: HOST_VENDOR_INFO[vendor].keyHelp, willRun: 'The new key is checked before replacing the saved key. Nothing is rented.', secret: true })
  if (!entered?.trim() || signal.aborted) return false
  const key = entered.trim()
  try { await vendorClient(vendor, { key, apiBaseUrl: options.apiBaseUrl }).pods(signal) } catch (error) {
    emit({ title: vendorLabel(vendor), words: String(error).split(key).join('[redacted]') + ' The saved key was kept.' })
    return false
  }
  signal.throwIfAborted()
  saveVendorKey(vendor, key)
  options.changed?.()
  return true
}
