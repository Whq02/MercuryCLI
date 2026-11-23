import { readFileSync } from 'node:fs'

import { getErrnoCode } from '../errors/errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { passedOver } from '../errors/passedOver.js'
import { ancestorPidsCommand, processStartProbeKind } from '../host-os/processes.js'


export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return getErrnoCode(error) === 'EPERM'
  }
}

export function procStartToken(pid: number): string | undefined {
  if (processStartProbeKind() !== 'linux-proc') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closeParen = stat.lastIndexOf(')')
    if (closeParen === -1) return undefined
    const tail = stat.slice(closeParen + 2).split(' ')
    const token = tail[19]
    return token && token.length > 0 ? token : undefined
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function currentProcStart(): string | undefined {
  return procStartToken(process.pid)
}

const ANCESTOR_TIMEOUT_MS = 3000

export async function getAncestorPidsAsync(pid: number, maxDepth: number = 10): Promise<number[]> {
  const cmd = ancestorPidsCommand(pid, maxDepth)
  const result = await execFileNoThrow(cmd.file, cmd.args, {
    timeout: ANCESTOR_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  if (result.code !== 0 || result.stdout.trim() === '') return []
  return result.stdout
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => Number(entry))
    .filter(entry => Number.isInteger(entry))
}
