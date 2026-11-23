import { stat } from 'node:fs/promises'
import { memoize } from 'lodash-es'
import { env } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { passedOver } from './passedOver.js'

const getIsDocker = memoize(async (): Promise<boolean> => {
  if (process.platform !== 'linux') return false
  return (await execFileNoThrow('test', ['-f', '/.dockerenv'])).code === 0
})

let muslProbeResult = false
if (process.platform === 'linux') {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  void stat(`/lib/libc.musl-${arch}.so.1`).then(() => { muslProbeResult = true }).catch(passedOver)
}

export const envDynamic = { ...env, getIsDocker, isMuslEnvironment: () => process.platform === 'linux' && muslProbeResult }
