import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { hostMachineName } from '../../commands/llmhost/words.js'
import { hostDirectory } from './store.js'
import type { HostOffer } from './runpod.js'
import type { HostVendor } from './vendors/vendor.js'


type HostVendorId = HostVendor['vendor']
export interface HostRental { vendor: HostVendorId; id: string; name?: string; machineId?: string }
export type HostLinkEvent =
  | { outcome: 'reconnecting'; attempt: number; why: string }
  | { outcome: 'recovered'; attempt: number }
  | { outcome: 'lost'; attempt: number; why: string }
export interface HostMachineTrouble { rank: 0 | 1; words: string; drops: number; last?: HostLinkOutage }

const idPattern = /^[a-zA-Z0-9_-]+$/
const outageSchema = z.object({ at: z.string(), closedAt: z.string().optional(), reconnects: z.number().int().nonnegative(), outcome: z.enum(['reconnecting', 'recovered', 'lost']), why: z.string() })
const observationSchema = z.object({
  vendor: z.enum(['runpod', 'vast', 'lambda', 'huggingface', 'hyperstack', 'verda', 'digitalocean']), rental: z.string().regex(idPattern), name: z.string().optional(), machineId: z.string().min(1).optional(),
  outages: z.array(outageSchema),
})
export type HostLinkOutage = z.infer<typeof outageSchema>
export type HostLinkObservation = z.infer<typeof observationSchema>

export function hostMachineOf(vendor: HostVendorId, offer: Pick<HostOffer, 'machineId'>): string | undefined {
  return vendor === 'vast' && offer.machineId !== undefined ? String(offer.machineId) : undefined
}

const directory = (): string => join(hostDirectory(), 'reliability')
const pathOf = (vendor: HostVendorId, rental: string): string => {
  if (!idPattern.test(rental)) throw new Error('Invalid host rental id')
  return join(directory(), vendor + '-' + rental + '.json')
}
const parse = (text: string): HostLinkObservation | undefined => { const read = observationSchema.safeParse(JSON.parse(text)); return read.success ? read.data : undefined }
export function readHostLinkObservation(vendor: HostVendorId, rental: string): HostLinkObservation | undefined {
  try { return parse(readFileSync(pathOf(vendor, rental), 'utf8')) } catch { return undefined }
}
export function hostLinkObservations(): HostLinkObservation[] {
  let names: string[]
  try { names = readdirSync(directory()) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  return names.filter(name => name.endsWith('.json')).sort().flatMap(name => { try { const row = parse(readFileSync(join(directory(), name), 'utf8')); return row ? [row] : [] } catch { return [] } })
}

export function noteHostLink(rental: HostRental, event: HostLinkEvent, at = Date.now()): HostLinkObservation {
  const path = pathOf(rental.vendor, rental.id)
  const stamp = new Date(at).toISOString()
  const previous = readHostLinkObservation(rental.vendor, rental.id)
  const outages = [...(previous?.outages ?? [])]
  const open = outages.at(-1)?.outcome === 'reconnecting' ? outages.pop()! : undefined
  if (event.outcome === 'reconnecting') {
    if (open && event.attempt > 1) outages.push({ ...open, reconnects: event.attempt, why: event.why })
    else outages.push(...(open ? [open] : []), { at: stamp, reconnects: event.attempt, outcome: 'reconnecting', why: event.why })
  } else {
    const closing = open ?? { at: stamp, reconnects: event.attempt, outcome: 'reconnecting' as const, why: '' }
    outages.push({ ...closing, closedAt: stamp, reconnects: event.attempt, outcome: event.outcome, why: event.outcome === 'lost' ? event.why : closing.why })
  }
  const machineId = rental.machineId ?? previous?.machineId
  const name = rental.name ?? previous?.name
  const observation = observationSchema.parse({ vendor: rental.vendor, rental: rental.id, ...(name ? { name } : {}), ...(machineId ? { machineId } : {}), outages })
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  publishAtomicSync(path, JSON.stringify(observation) + '\n', { mode: 0o600 })
  return observation
}

const count = (n: number): string => n + ' reconnect' + (n === 1 ? '' : 's')
const elapsedWords = (outage: HostLinkOutage, now: number): string => {
  const ms = Math.max(0, (outage.closedAt ? Date.parse(outage.closedAt) : now) - Date.parse(outage.at))
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' min' + (seconds % 60 ? ' ' + seconds % 60 + ' s' : '')
}
export const hostRentalWords = (rental: Pick<HostLinkObservation, 'vendor' | 'rental' | 'name' | 'machineId'>): string => hostMachineName(rental.vendor, rental.rental) + (rental.name ? ' · ' + rental.name : '') + (rental.machineId ? ' · machine ' + rental.machineId : '')
export function hostLinkAttemptWords(observation: HostLinkObservation, budget: number): string {
  const outage = observation.outages.at(-1)!
  return 'tunnel dropped · reconnecting · attempt ' + outage.reconnects + ' of ' + budget + ' · ' + hostRentalWords(observation) + ' · ' + outage.why
}
export function hostLinkRecoveredWords(observation: HostLinkObservation, port: number, now = Date.now()): string {
  const outage = observation.outages.at(-1)!
  return 'tunnel reconnected on 127.0.0.1:' + port + ' · ' + hostRentalWords(observation) + ' · after ' + count(outage.reconnects) + ' over ' + elapsedWords(outage, now)
}
export function hostLinkLossWords(observation: HostLinkObservation, now = Date.now()): string {
  const outage = observation.outages.at(-1)!
  return 'The SSH tunnel to ' + hostRentalWords(observation) + ' dropped and ' + count(outage.reconnects) + ' failed over ' + elapsedWords(outage, now) + ': ' + outage.why
}

export function hostLinkChatCause(rental: HostRental, cause: string): string {
  const outage = readHostLinkObservation(rental.vendor, rental.id)?.outages.at(-1)
  const reconnects = outage && outage.outcome !== 'recovered' ? outage.reconnects : 0
  return hostRentalWords({ ...rental, rental: rental.id }) + ' · Mercury: ' + count(reconnects) + ' to the machine · ' + cause
}

export function hostMachineTrouble(vendor: HostVendorId, offer: Pick<HostOffer, 'machineId'>, observations?: readonly HostLinkObservation[], now = Date.now()): HostMachineTrouble {
  const machine = hostMachineOf(vendor, offer)
  if (!machine) return { rank: 0, words: '', drops: 0 }
  let rows: readonly HostLinkObservation[]
  try { rows = observations ?? hostLinkObservations() } catch { return { rank: 0, words: '', drops: 0 } }
  const outages = rows.filter(row => row.vendor === vendor && row.machineId === machine).flatMap(row => row.outages).sort((a, b) => a.at.localeCompare(b.at))
  const last = outages.at(-1)
  if (!last) return { rank: 0, words: '', drops: 0 }
  const minutes = Math.max(0, Math.floor((now - Date.parse(last.at)) / 60_000))
  return { rank: 1, drops: outages.length, last, words: 'link dropped ' + minutes + ' min ago · ' + count(last.reconnects) }
}
