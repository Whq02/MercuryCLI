import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mintTensorFoldKey } from '../../../daemon/lan/pairing.js'
import { publishAtomicSync } from '../../../platform/substrate/fileStore.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { errorMessage, getErrnoCode, isENOENT } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { readExposedFileModeSync } from '../../../platform/host-os/files.js'
import { refuseProofWriteIntoAccountStore } from '../proofHomeGuard.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

const TENSORFOLD_KEY_LABEL = 'mercury'
const TENSORFOLD_KEY_SCOPE = 'inference'

interface TensorFoldKeyFile {
  path: string
  key: string
  line: string
}

type TensorFoldKeyFileRead =
  | { state: 'absent' }
  | { state: 'read'; file: TensorFoldKeyFile }
  | { state: 'unusable'; why: 'can be read by other users' | 'holds no key' }
  | { state: 'unreadable'; code: string; message: string }

function tensorFoldKeyLine(key: string, label: string = TENSORFOLD_KEY_LABEL): string {
  return `${label}[${TENSORFOLD_KEY_SCOPE}]: ${key}`
}

export function tensorFoldKeyFilePath(home: string = getMercuryHome()): string {
  return join(home, 'local-setup', 'tensorfold', 'api-key')
}

function probeTensorFoldKeyFile(path: string): TensorFoldKeyFileRead {
  let line: string | undefined
  try {
    if (readExposedFileModeSync(path, 0o066) !== null) return { state: 'unusable', why: 'can be read by other users' }
    line = readFileSync(path, 'utf8').split('\n').find(row => row.trim() !== '' && !row.trim().startsWith('#'))
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' }
    return { state: 'unreadable', code: code ?? 'EUNKNOWN', message: errorMessage(error) }
  }
  if (line === undefined) return { state: 'unusable', why: 'holds no key' }
  const colon = line.indexOf(':')
  const key = (colon >= 0 ? line.slice(colon + 1) : line).trim()
  if (key === '' || /\s/.test(key)) return { state: 'unusable', why: 'holds no key' }
  return { state: 'read', file: { path, key, line: line.trim() } }
}

let keyFileUnreadSaid: string | undefined

export function readTensorFoldKeyFile(path: string = tensorFoldKeyFilePath()): TensorFoldKeyFile | undefined {
  const read = probeTensorFoldKeyFile(path)
  if (read.state === 'read') return read.file
  if (read.state === 'unreadable' && read.message !== keyFileUnreadSaid) {
    keyFileUnreadSaid = read.message
    logError(new Error(`the TensorFold key file could not be read (${read.message}), so its key is not used`))
  }
  return undefined
}

function keyToKeep(path: string, home: string): string | undefined {
  const read = probeTensorFoldKeyFile(path)
  if (read.state === 'read') return read.file.key
  if (read.state === 'unreadable') {
    throw Object.assign(
      new Error(`The TensorFold key file at ${path} exists but could not be read (${read.code}); nothing was written. Make it readable, or move it away to mint a new key, then share again.`),
      { code: read.code },
    )
  }
  if (read.state === 'unusable') {
    const { keepDamagedFileAsideSync } = require('../../../platform/substrate/storeRecovery.js') as typeof import('../../../platform/substrate/storeRecovery.js')
    try {
      keepDamagedFileAsideSync({ store: 'tensorfold-key', path, reason: read.why, by: 'copy', asideAt: stamp => join(home, `.tensorfold-key.corrupt.${stamp}-auth.json`) })
    } catch (error) {
      if (isENOENT(error)) return undefined
      const code = getErrnoCode(error) ?? errorMessage(error)
      throw Object.assign(new Error(`The TensorFold key file at ${path} ${read.why} and could not be kept aside (${code}); nothing was written. Move it away, then share again.`), { code })
    }
  }
  return undefined
}

export function writeTensorFoldKeyFile(opts: { path?: string; key?: string; label?: string } = {}): TensorFoldKeyFile {
  const path = opts.path ?? tensorFoldKeyFilePath()
  const home = getMercuryHome()
  refuseProofWriteIntoAccountStore(home, 'the TensorFold key file')
  const key = opts.key ?? keyToKeep(path, home) ?? mintTensorFoldKey()
  const line = tensorFoldKeyLine(key, opts.label)
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  publishAtomicSync(path, `${line}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch (error) {
    passedOver(error)
  }
  return { path, key, line }
}
