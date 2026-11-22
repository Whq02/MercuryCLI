import { flagPair } from '../../substrate/flagRegistry.js'
import type { ScopedLspServerConfig } from '../../services/lsp/types.js'
import { activeFor } from '../active.js'
import { optionEnv, substituteOptionsInCommand, substituteRootAndData } from '../options.js'
import { getExtensionDataDir } from '../paths.js'
import { notBuilt } from '../../pi/holes.js'

let memo: Record<string, ScopedLspServerConfig> | null = null

export function getExtensionLspServers(): Record<string, ScopedLspServerConfig> {
  return notBuilt('src/extensions/load/language.ts:9')
}

export function clearExtensionLspServerCache(): void {
  memo = null
}
