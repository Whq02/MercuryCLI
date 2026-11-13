import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'


const DEFAULT_TEMPLATE = `Automated maintenance instruction (not part of the user conversation; never reference it in the document).

Maintain the self-maintaining document at {{docPath}} (title: "{{docTitle}}"):

<document>
{{docContents}}
</document>

Fold substantive new learnings from the conversation into this document via edits, then stop; if nothing substantial is new, make no tool calls.

Rules:
- Keep the "# MAGIC DOC: …" marker line and any italic instruction line below it verbatim.
- Describe current state, not history: update in place, delete stale sections, never append "previously…" notes.
- Fix obvious errors and tighten organisation where you touch it.
- Cover architecture, entry points, rationale, non-obvious gotchas and cross-references — never exhaustive API/per-function listings, step-by-step implementation detail, or facts obvious from code.
- Write tersely; every line must carry signal.
{{customInstructions}}`

const CUSTOM_INSTRUCTIONS_PREAMBLE =
  'Document author instructions (override general rules above):'

function substitute(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? (variables[name] as string) : whole,
  )
}

async function loadTemplate(): Promise<string> {
  try {
    return await readFile(join(getMercuryHome(), 'magic-docs', 'prompt.md'), 'utf8')
  } catch {
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
