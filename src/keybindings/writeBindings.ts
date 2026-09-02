
import { readFile } from 'node:fs/promises'
import { isENOENT } from '../utils/errors.js'
import { durableAtomicPublish } from '../substrate/durablePublish.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { getKeybindingsPath } from './loadUserBindings.js'
import type { KeybindingBlock, KeybindingValue } from './types.js'

function serialize(config: {
  $docs?: string
  bindings: KeybindingBlock[]
}): string {
  return jsonStringify(config, null, 2) + '\n'
}

export const DOCS_LINE = 'Run /keys in Mercury for the live effective binding table'

export type BindingEdit = {
  context: string
  chord: string
  action: KeybindingValue
}

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
  await durableAtomicPublish(path, next.content)
  return { ok: true, path }
}
