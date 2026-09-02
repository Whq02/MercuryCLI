// ============================================================================
//  writeBindings — the atlas's write half.
//
//  `/keys` can rebind an action without leaving the panel: it writes the
//  operator's own keybindings.json and the loader's watcher hot-applies it,
//  so the table the panel is showing updates from the SAME source the runtime
//  resolves against. No in-memory override layer exists — a rebind that did
//  not survive a restart would be a lie the panel told.
//
//  The decision is a pure function over text (`applyBindingEdit`); the IO
//  wrapper is three lines. That is what lets
//  scripts/cockpit-interaction/prove-input-atlas.ts prove the exact bytes.
// ============================================================================

import { readFile } from 'node:fs/promises'
import { isENOENT } from '../utils/errors.js'
import { durableAtomicPublish } from '../substrate/durablePublish.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { getKeybindingsPath } from './loadUserBindings.js'
import type { KeybindingBlock, KeybindingValue } from './types.js'

/** The one place the file's serialized shape is decided. */
function serialize(config: {
  $docs?: string
  bindings: KeybindingBlock[]
}): string {
  return jsonStringify(config, null, 2) + '\n'
}

export const DOCS_LINE = 'Run /keys in Mercury for the live effective binding table'

export type BindingEdit = {
  context: string
  /** Keystroke pattern exactly as the config spells it, e.g. `"ctrl+x p"`. */
  chord: string
  /** Action id, `command:<name>`, or `null` to unbind the default. */
  action: KeybindingValue
}

/**
 * The file text after applying one edit to `existing` (null = no file yet).
 *
 * Merges into the block that already owns the context so a second rebind does
 * not append a duplicate block, and preserves any `$docs` the operator kept.
 * Unparseable input is a refusal, not an overwrite: the caller reports it and
 * the operator's file is left alone.
 */
export function applyBindingEdit(
  existing: string | null,
  edit: BindingEdit,
): { ok: true; content: string } | { ok: false; error: string } {
  let blocks: KeybindingBlock[] = []
  let docs: string | undefined = DOCS_LINE
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown
    try {
      parsed = jsonParse(existing)
    } catch {
      return { ok: false, error: 'keybindings.json is not valid JSON — fix it before rebinding here' }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, error: 'keybindings.json must be a JSON object' }
    }
    const record = parsed as { bindings?: unknown; $docs?: unknown }
    if (record.bindings !== undefined) {
      if (!Array.isArray(record.bindings)) {
        return { ok: false, error: 'keybindings.json "bindings" must be an array' }
      }
      blocks = record.bindings as KeybindingBlock[]
    }
    if (typeof record.$docs === 'string') docs = record.$docs
  }

  const target = blocks.find(b => b?.context === edit.context)
  if (target) {
    target.bindings = { ...target.bindings, [edit.chord]: edit.action }
  } else {
    blocks = [...blocks, { context: edit.context, bindings: { [edit.chord]: edit.action } }]
  }
  return { ok: true, content: serialize({ $docs: docs, bindings: blocks }) }
}

/** Apply one edit to the operator's config-home keybindings.json. The loader's
 *  watcher picks the write up and re-resolves; nothing is cached here. */
export async function writeUserBinding(
  edit: BindingEdit,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const path = getKeybindingsPath()
  let existing: string | null = null
  try {
    existing = await readFile(path, 'utf-8')
  } catch (error) {
    if (!isENOENT(error)) {
      return { ok: false, error: `could not read ${path}` }
    }
  }
  const next = applyBindingEdit(existing, edit)
  if (!next.ok) return next
  // Durable publication: this is the operator's own config file —
  // a crash mid-write must never leave truncated JSON, two same-process
  // writers must never share a temp (the old `.tmp-<pid>` name collided),
  // and a transient win32 file-use lock gets the owner's bounded retry. The
  // loader's watcher sees exactly one complete-file event.
  await durableAtomicPublish(path, next.content)
  return { ok: true, path }
}
