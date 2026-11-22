import { stripBOM } from '../utils/jsonRead.js'
import chokidar, { type FSWatcher } from 'chokidar'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { checkHasTrustDialogAccepted } from '../utils/config/trust.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { projectConfigDirs, resolveProjectConfigPath } from '../utils/projectConfig.js'
import { createSignal } from '../utils/signal.js'
import { ignoringSpecialFiles, resolveWatchRoot } from '../utils/watchRoot.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { parseBindings } from './parser.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import { checkDuplicateKeysInJson, validateBindings, type KeybindingWarning } from './validate.js'
import { isRecord } from '../utils/isRecord.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const FILE_NAME = 'keybindings.json'

export function isKeybindingCustomizationEnabled(): boolean {
  return notBuilt('src/keybindings/loadUserBindings.ts:26')
}

export type KeybindingsLoadResult = Unbuilt

export function getKeybindingsPath(): string {
  return notBuilt('src/keybindings/loadUserBindings.ts:35')
}

function folderTrusted(): boolean {
  try {
    return checkHasTrustDialogAccepted()
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function getProjectKeybindingsPath(): string | null {
  return folderTrusted() ? resolveProjectConfigPath(getCwd(), FILE_NAME) : null
}


type Layer = 'user' | 'project'

type ParsedLayer = {
  blocks: KeybindingBlock[] | null
  warnings: KeybindingWarning[]
}

const WRAPPER_SHAPE = '{ "bindings": [ { "context": "...", "bindings": { ... } } ] }'

function isBlockShape(value: unknown): value is KeybindingBlock {
  return isRecord(value) && typeof value.context === 'string' && isRecord(value.bindings)
}

function parseLayer(raw: string, layer: Layer): ParsedLayer {
  return notBuilt('src/keybindings/loadUserBindings.ts:66')
}

let extensionLayer: () => KeybindingBlock[] = () => []
export function setExtensionKeybindingLayer(provider: () => KeybindingBlock[]): void {
  extensionLayer = provider
}

export function invalidateKeybindingsCache(): void {
  cached = null
  cachedFor = null
}

function assemble(user: ParsedLayer | null, project: ParsedLayer | null): KeybindingsLoadResult {
  const bindings = parseBindings(DEFAULT_BINDINGS)
  try {
    bindings.push(...parseBindings(extensionLayer()))
  } catch (error) {
    logForDebugging(`keybindings: the extension layer failed to parse: ${error instanceof Error ? error.message : String(error)}`)
  }
  const warnings: KeybindingWarning[] = []
  const userBlocks: KeybindingBlock[] = []
  for (const layer of [user, project]) {
    if (!layer) continue
    warnings.push(...layer.warnings)
    if (layer.blocks) {
      bindings.push(...parseBindings(layer.blocks))
      userBlocks.push(...layer.blocks)
    }
  }
  if (userBlocks.length > 0) warnings.push(...validateBindings(userBlocks, bindings))
  return { bindings, warnings }
}


let cached: KeybindingsLoadResult | null = null
let cachedFor: string | null = null

function layersKey(): string {
  return `${getCwd()}\n${folderTrusted() ? 'trusted' : 'untrusted'}`
}

function readErrorLayer(layer: Layer, error: unknown): ParsedLayer {
  return {
    blocks: null,
    warnings: [
      {
        type: 'parse_error',
        severity: 'error',
        message: `Could not read the ${layer} keybindings file: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  }
}

function readLayerSync(path: string | null, layer: Layer): ParsedLayer | null {
  if (!path) return null
  try {
    return parseLayer(readFileSync(path, 'utf8'), layer)
  } catch (error) {
    if (isENOENT(error)) return null
    return readErrorLayer(layer, error)
  }
}

export function loadKeybindingsSyncWithWarnings(): KeybindingsLoadResult {
  const key = layersKey()
  if (cached && cachedFor === key) return cached
  const result = assemble(
    readLayerSync(getKeybindingsPath(), 'user'),
    readLayerSync(getProjectKeybindingsPath(), 'project'),
  )
  cached = result
  cachedFor = key
  return result
}

export function loadKeybindingsSync(): ParsedBinding[] {
  return notBuilt('src/keybindings/loadUserBindings.ts:200')
}


export async function loadKeybindings(): Promise<KeybindingsLoadResult> {
  return notBuilt('src/keybindings/loadUserBindings.ts:205')
}


const changes = createSignal<[KeybindingsLoadResult]>()

export async function initializeKeybindingWatcher(): Promise<void> {
  return notBuilt('src/keybindings/loadUserBindings.ts:241')
}

export function disposeKeybindingWatcher(): void {
  return notBuilt('src/keybindings/loadUserBindings.ts:299')
}

registerCleanup(async () => {
  disposeKeybindingWatcher()
})

export const subscribeToKeybindingChanges = changes.subscribe
