// Layered keybinding configuration: defaults < user home < project config
// home, each layer parsed independently and degrading to ABSENT on any
// fault (a broken layer contributes a warning, never poisons the merge), a
// cwd-keyed synchronous cache for the provider's first render, and a
// hot-reload watcher.

import { stripBOM } from '../utils/jsonRead.js'
import chokidar, { type FSWatcher } from 'chokidar'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { projectConfigDirs, resolveProjectConfigPath } from '../utils/projectConfig.js'
import { createSignal } from '../utils/signal.js'
import { resolveWatchRoot } from '../utils/watchRoot.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { parseBindings } from './parser.js'
import type { KeybindingBlock, ParsedBinding } from './types.js'
import { checkDuplicateKeysInJson, validateBindings, type KeybindingWarning } from './validate.js'

const FILE_NAME = 'keybindings.json'

/** Customisation is generally available; the predicate exists so a future
 *  capability profile could gate it without touching the callers. */
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

/** The project layer's file, or null when no project config home holds it. */
export function getProjectKeybindingsPath(): string | null {
  return resolveProjectConfigPath(getCwd(), FILE_NAME)
}

// ── layer parsing ──────────────────────────────────────────────────────────

type Layer = 'user' | 'project'

type ParsedLayer = {
  /** null ⇒ the layer is absent (broken or missing). */
  blocks: KeybindingBlock[] | null
  warnings: KeybindingWarning[]
}

const WRAPPER_SHAPE = '{ "bindings": [ { "context": "...", "bindings": { ... } } ] }'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBlockShape(value: unknown): value is KeybindingBlock {
  return isRecord(value) && typeof value.context === 'string' && isRecord(value.bindings)
}

function parseLayer(raw: string, layer: Layer): ParsedLayer {
  let parsed: unknown
  try {
    // BOM-stripped (the same Windows-editor class as .mcp.json; TASK-017 S2).
    parsed = JSON.parse(stripBOM(raw))
  } catch (error) {
    return {
      blocks: null,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `Invalid JSON in the ${layer} keybindings file: ${error instanceof Error ? error.message : String(error)}`,
          suggestion: 'Fix the JSON syntax or delete the file',
        },
      ],
    }
  }
  if (!isRecord(parsed) || !('bindings' in parsed)) {
    return {
      blocks: null,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `The ${layer} keybindings file must have a "bindings" array`,
          suggestion: `Use the shape ${WRAPPER_SHAPE}`,
        },
      ],
    }
  }
  const blocks = parsed.bindings
  if (!Array.isArray(blocks)) {
    return {
      blocks: null,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `The ${layer} keybindings file's "bindings" must be an array`,
          suggestion: `Use the shape ${WRAPPER_SHAPE}`,
        },
      ],
    }
  }
  if (!blocks.every(isBlockShape)) {
    return {
      blocks: null,
      warnings: [
        {
          type: 'parse_error',
          severity: 'error',
          message: `The ${layer} keybindings file has an invalid block: every entry must be { "context": string, "bindings": object }`,
          suggestion: `Use the shape ${WRAPPER_SHAPE}`,
        },
      ],
    }
  }
  return { blocks, warnings: checkDuplicateKeysInJson(raw) }
}

/**
 * The extension layer: the chords approved extensions contribute, already
 * filtered to chords the defaults and the operator's file leave free. It
 * sits between the defaults and the operator's layers, so the operator's
 * own binding always wins. Registered by the extensions core at boot.
 */
let extensionLayer: () => KeybindingBlock[] = () => []
export function setExtensionKeybindingLayer(provider: () => KeybindingBlock[]): void {
  extensionLayer = provider
}

/** A reload of the extensions drops the cached assembly; the next reader re-assembles. */
export function invalidateKeybindingsCache(): void {
  cached = null
  cachedCwd = null
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

// ── synchronous load (cwd-keyed cache) ─────────────────────────────────────

let cached: KeybindingsLoadResult | null = null
let cachedCwd: string | null = null

function readLayerSync(path: string | null, layer: Layer): ParsedLayer | null {
  if (!path) return null
  try {
    return parseLayer(readFileSync(path, 'utf8'), layer)
  } catch {
    // Any read failure is an absent layer, no warning.
    return null
  }
}

/** The provider needs bindings during its first render; the cache is keyed
 *  by cwd so an in-place session switch never leaks the project layer. */
export function loadKeybindingsSyncWithWarnings(): KeybindingsLoadResult {
  const cwd = getCwd()
  if (cached && cachedCwd === cwd) return cached
  const result = assemble(
    readLayerSync(getKeybindingsPath(), 'user'),
    readLayerSync(getProjectKeybindingsPath(), 'project'),
  )
  cached = result
  cachedCwd = cwd
  return result
}

export function loadKeybindingsSync(): ParsedBinding[] {
  return loadKeybindingsSyncWithWarnings().bindings
}

// ── asynchronous load ──────────────────────────────────────────────────────

export async function loadKeybindings(): Promise<KeybindingsLoadResult> {
  let user: ParsedLayer | null = null
  try {
    user = parseLayer(await readFile(getKeybindingsPath(), 'utf8'), 'user')
  } catch (error) {
    if (!isENOENT(error)) {
      return {
        bindings: parseBindings(DEFAULT_BINDINGS),
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: `Could not read the user keybindings file: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      }
    }
  }
  let project: ParsedLayer | null = null
  const projectPath = getProjectKeybindingsPath()
  if (projectPath) {
    try {
      project = parseLayer(await readFile(projectPath, 'utf8'), 'project')
    } catch {
      project = null
    }
  }
  return assemble(user, project)
}

// ── watcher ────────────────────────────────────────────────────────────────

const changes = createSignal<[KeybindingsLoadResult]>()
let watcher: FSWatcher | null = null
let watcherInitialized = false
let watcherDisposed = false

/** Idempotent, one-shot per process; refuses after disposal. */
export async function initializeKeybindingWatcher(): Promise<void> {
  if (watcherInitialized || watcherDisposed) return
  const userPath = getKeybindingsPath()
  const userDir = dirname(userPath)
  try {
    if (!existsSync(userDir) || !statSync(userDir).isDirectory()) {
      logForDebugging(`keybindings watcher: ${userDir} is not a directory; not watching`)
      return
    }
  } catch {
    logForDebugging(`keybindings watcher: cannot stat ${userDir}; not watching`)
    return
  }
  watcherInitialized = true

  // The file itself when it exists, else its existing parent directory at
  // depth 0 so a later creation still hot-applies (chokidar cannot arm an
  // absent file path); every path through the long-path resolver first.
  const targets = [userPath, ...projectConfigDirs(getCwd()).map(dir => join(dir, FILE_NAME))]
  const paths = new Set<string>()
  for (const target of targets) {
    if (existsSync(target)) {
      paths.add(resolveWatchRoot(target))
      continue
    }
    const parent = dirname(target)
    if (existsSync(parent)) paths.add(resolveWatchRoot(parent))
  }
  if (paths.size === 0) return

  const onChange = (path: string): void => {
    if (basename(path) !== FILE_NAME) return
    void loadKeybindings()
      .then(result => {
        cached = result
        cachedCwd = getCwd()
        changes.emit(result)
      })
      .catch(error => {
        logError(error)
      })
  }

  watcher = chokidar.watch([...paths], {
    depth: 0,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
    ignorePermissionErrors: true,
    usePolling: false,
    atomic: true,
  })
  // Watch death must degrade, never crash.
  watcher.on('error', error => {
    logForDebugging(`keybindings watcher error: ${error instanceof Error ? error.message : String(error)}`)
  })
  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)
}

export function disposeKeybindingWatcher(): void {
  watcherDisposed = true
  if (watcher) {
    void watcher.close().catch(() => {})
    watcher = null
  }
  changes.clear()
}

registerCleanup(async () => {
  disposeKeybindingWatcher()
})

export const subscribeToKeybindingChanges = changes.subscribe

export function getCachedKeybindingWarnings(): KeybindingWarning[] {
  return cached?.warnings ?? []
}
