#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()

const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')

const toolPrompt = await AskUserQuestionTool.prompt!({ getToolPermissionContext: () => ({}) } as never)

t.section('§1 — the question tool describes its interface, not a second asking doctrine')
{
  const CLAUSES: [string, string][] = [
    ['research-before-question', 'Investigate before asking'],
    ['evidence-eliminates-decided-choices', 'eliminate choices already decided'],
    ['never-ask-what-code-answers', 'a question the code answers is not a question'],
    ['consequential-only', 'unresolved, consequential decisions'],
    ['no-self-resolvable-details', 'test frameworks the repository already uses'],
    ['why-still-open', 'why the decision is still open'],
    ['distinct-options-with-consequences', 'genuinely distinct options'],
    ['honest-impact', 'never steer with loaded phrasing'],
    ['recommendation-first-labeled', '"(Recommended)"'],
    ['group-independent', 'Group independent decisions into one call'],
    ['sequence-dependent', 'dependent question only after its parent answer is known'],
    ['no-re-ask-without-new-evidence', 'Do not re-ask a question the user already answered'],
    ['stop-when-resolved', 'Stop asking when all material ambiguity is resolved'],
  ]
  for (const [name, needle] of CLAUSES) {
    t.check(`the tool does not duplicate ${name}`, !toolPrompt.includes(needle), needle)
  }
  t.check('the description names questions and answers under 100 bytes', toolPrompt.startsWith('Ask structured multiple-choice questions') && toolPrompt.includes("user's answers") && Buffer.byteLength(toolPrompt) <= 100)
  const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
  const fields = (zodToJsonSchema(AskUserQuestionTool.inputSchema) as any).properties.questions.items.properties
  t.check('the Other answer and multi-select meanings live only in their fields', fields.options.description.includes('Other free-text answer is supplied automatically') && fields.multiSelect.description.includes('Allow several answers') && !/Other|multiSelect/.test(toolPrompt))
  const { PREVIEW_FEATURE_PROMPT } = await import('../../src/tools/AskUserQuestionTool/prompt.ts')
  t.check('preview formats keep their grammar without worked scenarios', PREVIEW_FEATURE_PROMPT.markdown.includes('Markdown in a monospace box') && PREVIEW_FEATURE_PROMPT.html.includes('without a document wrapper, script or style elements') && Object.values(PREVIEW_FEATURE_PROMPT).every(text => text.includes('Single-select only.') && !/mockups|Use previews/.test(text)))
}

t.finish('prove-asking-doctrine')
