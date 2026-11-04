import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mintTensorFoldKey } from '../../lan/pairing.js'
import { publishAtomicSync } from '../../../substrate/fileStore.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { refuseProofWriteIntoAccountStore } from '../../../utils/proofHomeGuard.js'

const TENSORFOLD_KEY_LABEL = 'mercury'
const TENSORFOLD_KEY_SCOPE = 'inference'

interface TensorFoldKeyFile {
  path: string
  key: string
  line: string
}

function tensorFoldKeyLine(key: string, label: string = TENSORFOLD_KEY_LABEL): string {
  return `${label}[${TENSORFOLD_KEY_SCOPE}]: ${key}`
}

export function tensorFoldKeyFilePath(home: string = getMercuryHome()): string {
  return join(home, 'local-setup', 'tensorfold', 'api-key')
}

export function readTensorFoldKeyFile(path: string = tensorFoldKeyFilePath()): TensorFoldKeyFile | undefined {
  try {
    if ((statSync(path).mode & 0o066) !== 0) return undefined
    const line = readFileSync(path, 'utf8').split('\n').find(row => row.trim() !== '' && !row.trim().startsWith('#'))
    if (line === undefined) return undefined
    const colon = line.indexOf(':')
    const key = (colon >= 0 ? line.slice(colon + 1) : line).trim()
    if (key === '' || /\s/.test(key)) return undefined
    return { path, key, line: line.trim() }
  } catch {
    return undefined
  }
}

export function writeTensorFoldKeyFile(opts: { path?: string; key?: string; label?: string } = {}): TensorFoldKeyFile {
  const path = opts.path ?? tensorFoldKeyFilePath()
  const home = getMercuryHome()
  refuseProofWriteIntoAccountStore(home, 'the TensorFold key file')
  const key = opts.key ?? readTensorFoldKeyFile(path)?.key ?? mintTensorFoldKey()
  const line = tensorFoldKeyLine(key, opts.label)
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  publishAtomicSync(path, `${line}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
  }
  return { path, key, line }
}

export const TENSORFOLD_KEY_PASTE_WORDS = 'paste this one line into the key file on the serving Mac'
