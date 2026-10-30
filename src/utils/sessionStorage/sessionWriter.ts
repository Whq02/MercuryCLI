import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { acquirePidLock } from '../../substrate/pidLock.js'

const owner = randomUUID()
const held = new Set<string>()
let exitHook = false

export async function claimSessionWriter(transcriptPath: string): Promise<void> {
  const directory = dirname(resolve(transcriptPath))
  mkdirSync(directory, { recursive: true })
  const path = join(realpathSync(directory), `${basename(transcriptPath)}.writer.lock`)
  if (held.has(path)) return
  const claim = await acquirePidLock(path, owner, { liveness: 'assume-alive' })
  if (!claim.held) throw new Error(`Session ${basename(transcriptPath, '.jsonl')} is already open in another process. Close it before resuming.`)
  held.add(path)
  if (exitHook) return
  exitHook = true
  process.once('exit', () => {
    for (const lock of held) {
      try {
        const holder = JSON.parse(readFileSync(lock, 'utf8'))
        if (holder.owner === owner && holder.pid === process.pid) unlinkSync(lock)
      } catch {}
    }
  })
}
