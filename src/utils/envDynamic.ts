import { stat } from 'node:fs/promises'

import { memoize } from 'lodash-es'

import { env } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'


const getIsDocker = memoize(async (): Promise<boolean> => {
  if (process.platform !== 'linux') return false
  const result = await execFileNoThrow('test', ['-f', '/.dockerenv'])
  return result.code === 0
})

function getIsBubblewrapSandbox(): boolean {
  return false
}

let muslProbeResult = false
if (process.platform === 'linux') {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  void stat(`/lib/libc.musl-${arch}.so.1`).then(
    () => {
      muslProbeResult = true
    },
    () => {
      muslProbeResult = false
    },
  )
}

function isMuslEnvironment(): boolean {
  if (process.platform !== 'linux') return false
  return muslProbeResult
}

export const envDynamic = {
  ...env,
  getIsDocker,
  getIsBubblewrapSandbox,
  isMuslEnvironment,
}
