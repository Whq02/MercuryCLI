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

const FILE_NAME = 'keybindings.json'

export function isKeybindingCustomizationEnabled(): boolean {
  return true
}

export type KeybindingsLoadResult = {
  bindings: ParsedBinding[]
  warnings: KeybindingWarning[]
}

export function getKeybindingsPath(): string {
  return join(getMercuryHome(), FILE_NAME)
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
  const refuse = (message: string, suggestion = `Use the shape ${WRAPPER_SHAPE}`): ParsedLayer => ({
    blocks: null,
    warnings: [{ type: 'parse_error', severity: 'error', message, suggestion }],
  })
  let value: unknown
  try {
    value = JSON.parse(stripBOM(raw))
  } catch (error) {
    return refuse(`Invalid JSON in the ${layer} keybindings file: ${error instanceof Error ? error.message : String(error)}`, 'Fix the JSON syntax or delete the file')
  }
  if (!isRecord(value) || !Object.hasOwn(value, 'bindings')) return refuse(`The ${layer} keybindings file must have a "bindings" array`)
  const blocks = value.bindings
  if (!Array.isArray(blocks)) return refuse(`The ${layer} keybindings file's "bindings" must be an array`)
  if (!blocks.every(isBlockShape)) return refuse(`The ${layer} keybindings file has an invalid block: every entry must be { "context": string, "bindings": object }`)
  return { blocks, warnings: checkDuplicateKeysInJson(raw) }
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
  return loadKeybindingsSyncWithWarnings().bindings
}


export async function loadKeybindings(): Promise<KeybindingsLoadResult> {
  let user: ParsedLayer | null = null
  try {
    user = parseLayer(await readFile(getKeybindingsPath(), 'utf8'), 'user')
  } catch (error) {
    if (!isENOENT(error)) return { bindings: parseBindings(DEFAULT_BINDINGS), warnings: readErrorLayer('user', error).warnings }
  }
  const path = getProjectKeybindingsPath()
  let project: ParsedLayer | null = null
  if (path !== null) {
    try {
      project = parseLayer(await readFile(path, 'utf8'), 'project')
    } catch (error) {
      if (!isENOENT(error)) project = readErrorLayer('project', error)
    }
  }
  return assemble(user, project)
}


const changes = createSignal<[KeybindingsLoadResult]>()

let watcher: FSWatcher | null = null
let watcherInitialized = false
let watcherDisposed = false
export async function initializeKeybindingWatcher(): Promise<void> {
  if (watcherInitialized || watcherDisposed) return
  const userPath = getKeybindingsPath()
  const home = dirname(userPath)
  try {
    if (!existsSync(home) || !statSync(home).isDirectory()) {
      logForDebugging(`keybindings watcher: ${home} is not a directory; not watching`)
      return
    }
  } catch {
    logForDebugging(`keybindings watcher: cannot stat ${home}; not watching`)
    return
  }
  watcherInitialized = true
  const roots = new Set<string>()
  for (const path of [userPath, ...projectConfigDirs(getCwd()).map(folder => join(folder, FILE_NAME))]) {
    if (existsSync(path)) roots.add(resolveWatchRoot(path))
    else if (existsSync(dirname(path))) roots.add(resolveWatchRoot(dirname(path)))
  }
  if (!roots.size) return
  watcher = chokidar.watch([...roots], {
    depth: 0, persistent: true, ignoreInitial: true, usePolling: false, atomic: true,
    ignorePermissionErrors: true, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }, ignored: ignoringSpecialFiles(),
  })
  const reload = (path: string): void => {
    if (basename(path) !== FILE_NAME) return
    void loadKeybindings().then(result => {
      cached = result
      cachedFor = layersKey()
      changes.emit(result)
    }).catch(logError)
  }
  watcher.on('add', reload).on('change', reload).on('unlink', reload).on('error', error => {
    logForDebugging(`keybindings watcher error: ${error instanceof Error ? error.message : String(error)}`)
  })
}

export function disposeKeybindingWatcher(): void {
  watcherDisposed = true
  if (watcher) {
    void watcher.close().catch(passedOver)
    watcher = null
  }
  changes.clear()
}

registerCleanup(async () => {
  disposeKeybindingWatcher()
})

export const subscribeToKeybindingChanges = changes.subscribe
