import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProcessStartTokenCachedOrRefresh, getProcessStartTokenAsync, isProcessAlive } from '../../../daemon/ownerWatch.js'
import { publishAtomicSync } from '../../../substrate/fileStore.js'
import { acquirePidLockWithRetry } from '../../../substrate/pidLock.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { logForDebugging } from '../../../utils/debug.js'

interface SlotHolder { owner: string; slot: number; pid: number; start?: string; crewmate: boolean }

export function compatEndpointDigest(baseUrl: string): string {
  return createHash('sha256').update(new URL(baseUrl).href.replace(/\/+$/, '').replace(/\/v1$/, '')).digest('hex')
}

export async function assignLlamacppSlot(
  endpoint: { baseUrl: string },
  sessionOwner: string,
  totalSlots: number,
  crewmate: boolean,
): Promise<number | undefined> {
  if (!Number.isSafeInteger(totalSlots) || totalSlots <= 0) return undefined
  let release: (() => Promise<unknown>) | undefined
  try {
    const directory = join(getMercuryHome(), 'cache', 'compat-slots')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, compatEndpointDigest(endpoint.baseUrl) + '.json')
    const owner = createHash('sha256').update(sessionOwner).digest('hex')
    const start = await getProcessStartTokenAsync(process.pid)
    ;({ release } = await acquirePidLockWithRetry(path + '.lock', randomUUID(), { liveness: 'assume-alive' }))
    let holders: SlotHolder[] = []
    try {
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid slot registry')
      holders = data.filter((row): row is SlotHolder => row && typeof row.owner === 'string' && /^[a-f0-9]{64}$/.test(row.owner) && Number.isSafeInteger(row.slot) && row.slot >= 0 && Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.crewmate === 'boolean' && (row.start === undefined || typeof row.start === 'string'))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const held = holders.find(row => row.owner === owner && row.slot < totalSlots)
    holders = holders.filter(row => {
      if (row.owner === owner || row.slot >= totalSlots || !isProcessAlive(row.pid)) return false
      const token = row.start ? getProcessStartTokenCachedOrRefresh(row.pid) : null
      return token === null || token === row.start
    })
    const counts = new Map<number, number>()
    const mainSlots = new Set<number>()
    for (const row of holders) {
      counts.set(row.slot, (counts.get(row.slot) ?? 0) + 1)
      if (!row.crewmate) mainSlots.add(row.slot)
    }
    let slot = held?.slot
    if (slot === undefined) {
      const preferred = Number.parseInt(owner.slice(0, 8), 16) % totalSlots
      slot = preferred
      for (let step = 0; step <= Math.min(holders.length, totalSlots - 1); step++) {
        const candidate = (preferred + step) % totalSlots
        const count = counts.get(candidate) ?? 0
        const best = counts.get(slot) ?? 0
        if (count < best || count === best && mainSlots.has(slot) && !mainSlots.has(candidate)) slot = candidate
        if (count === 0) { slot = candidate; break }
      }
    }
    holders.push({ owner, slot, pid: process.pid, ...(start ? { start } : {}), crewmate })
    publishAtomicSync(path, JSON.stringify(holders) + '\n', { mode: 0o600 })
    return slot
  } catch (error) {
    logForDebugging(`llama.cpp slot affinity unavailable; the engine will select a slot: ${String(error)}`, { level: 'warn' })
    return undefined
  } finally { await release?.() }
}
