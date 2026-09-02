import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'

/**
 * Builds the Magic-Docs update prompt (default template, optional operator
 * override file, `{{var}}` substitution). Only reachable from the (inert)
 * magicDocs module.
 */

const DEFAULT_TEMPLATE = `This message is an automated maintenance instruction. It is not part of the user conversation, and the document must never reference it.

You maintain the self-maintaining document at {{docPath}} (title: "{{docTitle}}"). Its current contents:

<document>
{{docContents}}
</document>

Your task: fold genuinely new learnings from the conversation so far into this document with edits, then stop. If the conversation adds nothing substantial, make no tool call at all — do nothing.

Rules:
- Preserve the marker line ("# MAGIC DOC: …") and any italic instruction line beneath it verbatim.
- The document describes CURRENT state; it is not a changelog. Update in place, delete stale sections, and never append "previously…" notes.
- Fix obvious errors and improve organisation where you touch it.
- The document is for architecture, entry points, rationale, non-obvious gotchas and cross-references. It is NOT for exhaustive API listings, per-function documentation, step-by-step implementation detail, or anything obvious from reading the code.
- Write tersely; every line must carry signal.
{{customInstructions}}`

const CUSTOM_INSTRUCTIONS_PREAMBLE =
  'The document author left these instructions; they take priority over the general rules above:'

/**
 * Single-pass `{{name}}` substitution: a value containing a `{{token}}` for a
 * later variable is not re-substituted, and `$` sequences are inserted
 * literally. Placeholder names are word characters; unknown placeholders
 * are left in place.
 */
function substitute(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? (variables[name] as string) : whole,
  )
}

async function loadTemplate(): Promise<string> {
  try {
    return await readFile(join(getMercuryHome(), 'magic-docs', 'prompt.md'), 'utf8')
  } catch {
    // Silent fallback to the built-in template on any read failure.
    return DEFAULT_TEMPLATE
  }
}

export async function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  instructions?: string,
): Promise<string> {
  const template = await loadTemplate()
  const customInstructions =
    instructions !== undefined && instructions !== ''
      ? `\n\n${CUSTOM_INSTRUCTIONS_PREAMBLE}\n\n${instructions}`
      : ''
  return substitute(template, { docContents, docPath, docTitle, customInstructions })
}
