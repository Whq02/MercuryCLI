import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../platform/substrate/fileStore.js'
import { forgetTensorFoldHost } from '../roads/local/tensorfoldHosts.js'
import { TENSORFOLD_NOT_BUILT } from '../tensorfold/contracts.js'
import { hostDirectory } from './store.js'

export const tensorFoldPodHostName = (id: string): string => ('pod-' + id.toLowerCase().replaceAll('_', '-')).slice(0, 28)
const keysDirectory = (): string => {
  const dir = join(hostDirectory(), 'tensorfold')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
const keyFile = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid host record id')
  return join(keysDirectory(), id + '.key')
}
export function tensorFoldPodKey(id: string): string {
  const path = keyFile(id)
  if (existsSync(path)) { chmodSync(path, 0o600); return readFileSync(path, 'utf8').trim() }
  const key = randomBytes(24).toString('base64url')
  publishAtomicSync(path, key + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return key
}
export function forgetTensorFoldPodKey(id: string): void {
  try { unlinkSync(keyFile(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
export async function unregisterTensorFoldPod(id: string, forget: (name: string) => Promise<void> = forgetTensorFoldHost): Promise<void> {
  const hostName = tensorFoldPodHostName(id)
  try { await forget(hostName) } catch (error) { if (!String(error).includes(TENSORFOLD_NOT_BUILT)) throw error }
  const box = join(hostDirectory(), 'boxes', hostName + '.json')
  try { unlinkSync(box) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  forgetTensorFoldPodKey(id)
}
