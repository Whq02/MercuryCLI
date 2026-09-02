
import { realpathSync } from 'node:fs'
import { expandPath } from '../../utils/path.js'
import { runtimeKernel } from '../primitives/runtimeKernel.js'
import { subscribeToolTerminal } from '../run/effectObserver.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'

export const NO_CHANGE_REPETITION_CEILING = 3

const PATH_ENTRY_CAP = 128

export interface NoChangeObservation {
  operation: string
  path: string
  revision: string
  intentDigest: string
  displayPath?: string
}

export interface RepetitionVerdict {
  streak: number
  atCeiling: boolean
  guidance: string
}

interface PathEntry {
  key: string
  count: number
}

interface RepetitionState {
  entries: Map<string, PathEntry>
}

const store = new OwnerScopedStore<RepetitionState>({
  name: 'no-change-repetition',
  create: () => ({ entries: new Map() }),
  cap: 64,
})
registerOwnerScopedStore(store)

const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32'

export function canonicalNoChangePath(path: string): string {
  const expanded = expandPath(path)
  let canonical: string
  try {
    canonical = realpathSync(expanded)
  } catch {
    canonical = expanded
  }
  return CASE_INSENSITIVE_FS ? canonical.toLowerCase() : canonical
}

export function serializeIntentDigest(material: readonly unknown[]): string {
  return runtimeKernel().hash.sha256Hex(JSON.stringify(material)).slice(0, 16)
}

function operationNoun(operation: string): string {
  switch (operation) {
    case 'file.edit':
      return 'edit'
    case 'file.write':
      return 'write'
    case 'file.changeSet':
      return 'change set'
    default:
      return operation
  }
}

function guidanceFor(
  obs: NoChangeObservation,
  streak: number,
): string {
  const noun = operationNoun(obs.operation)
  const display = obs.displayPath ?? obs.path
  if (streak >= NO_CHANGE_REPETITION_CEILING) {
    return (
      `Stop repeating this ${noun}: it has produced no change ${streak} consecutive times on ${display} — ` +
      `the file already matches the intended state (current anchor: ${obs.revision}). ` +
      `Re-read the file and take a different action.`
    )
  }
  if (streak === 1) {
    return (
      `The file already matches this ${noun}. ` +
      `If you expected different content, re-read ${display} (current anchor: ${obs.revision}) before retrying.`
    )
  }
  return (
    `Repeated no-change: this identical ${noun} has produced no change ${streak} times in a row on ${display}. ` +
    `Re-read the file (current anchor: ${obs.revision}) and reassess — another identical call returns an error.`
  )
}

export function recordNoChangeOutcome(
  owner: OwnerKey,
  obs: NoChangeObservation,
): RepetitionVerdict {
  try {
    const state = store.get(owner)
    const pathKey = canonicalNoChangePath(obs.path)
    const key = [obs.operation, pathKey, obs.revision, obs.intentDigest].join(
      '\u0000',
    )
    const prior = state.entries.get(pathKey)
    const count = prior && prior.key === key ? prior.count + 1 : 1
    state.entries.delete(pathKey)
    state.entries.set(pathKey, { key, count })
    if (state.entries.size > PATH_ENTRY_CAP) {
      const oldest = state.entries.keys().next().value as string | undefined
      if (oldest !== undefined) state.entries.delete(oldest)
    }
    return {
      streak: count,
      atCeiling: count >= NO_CHANGE_REPETITION_CEILING,
      guidance: guidanceFor(obs, count),
    }
  } catch {
    return { streak: 1, atCeiling: false, guidance: guidanceFor(obs, 1) }
  }
}

export function noteSuccessfulMutation(
  owner: OwnerKey,
  changedPaths: readonly string[],
): void {
  const state = store.peek(owner)
  if (!state || state.entries.size === 0) return
  for (const path of changedPaths) {
    try {
      state.entries.delete(canonicalNoChangePath(path))
    } catch {
    }
  }
}

let installed = false
export function installRepetitionResetObserver(): void {
  if (installed) return
  installed = true
  subscribeToolTerminal(event => {
    if (
      event.effect &&
      event.effect.outcome === 'succeeded' &&
      event.effect.changedPaths.length > 0
    ) {
      noteSuccessfulMutation(event.owner, event.effect.changedPaths)
    }
  })
}
installRepetitionResetObserver()

export function _resetRepetitionPolicyForTesting(): void {
  store.clearAllForShutdown()
}
