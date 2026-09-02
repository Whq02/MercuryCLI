#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-asking-doctrine.ts — the ACTUAL assembled
//  model prompt enforces research-before-question, and the doctrine lives in
//  exactly one owner apiece (no composer/tool/attachment duplication).
//
//    §1  THE ASSEMBLED TOOL PROMPT — AskUserQuestionTool.prompt() (the real
//        provider, not a copied string) carries every doctrine clause.
//    §2  PLAN-APPROVAL SEPARATION — approval never travels through the
//        question tool (the standing rule survives the rewrite).
//    §3  ONE PLAN-ENTRY DOCTRINE — the assembled EnterPlanMode prompt is the
//        selective, evidence-based body; the aggressive inherited markers
//        and the zero-caller variant are absent.
//    §4  ONE OWNER PER CLAUSE — the plan attachment defers to the tool's
//        doctrine instead of duplicating bullets.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')
const { getEnterPlanModeToolPrompt } = await import('../../src/tools/EnterPlanModeTool/prompt.js')

const toolPrompt = await AskUserQuestionTool.prompt!({ getToolPermissionContext: () => ({}) } as never)

t.section('§1 — the assembled question-tool prompt carries the doctrine')
{
  const CLAUSES: [string, string][] = [
    ['research-before-question', 'Investigate before asking'],
    ['evidence-eliminates-decided-choices', 'eliminate choices already decided'],
    ['never-ask-what-code-answers', 'Never ask what you could find out by reading the code'],
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
    t.check(`the assembled prompt carries ${name}`, toolPrompt.includes(needle), needle)
  }
}

t.section('§2 — plan approval never travels through the question tool')
{
  // Mechanism pin: the plan-approval question is named inside a prohibiting
  // sentence — the exact prose is the prompt estate's own.
  t.check(
    'the assembled prompt forbids plan-approval questions',
    /\b(?:never|do not|don't)\b[^.\n]*"Is my plan ready\?"/i.test(toolPrompt),
  )
}

t.section('§3 — one selective plan-entry doctrine')
{
  const planPrompt = getEnterPlanModeToolPrompt()
  t.check('plan entry keys on genuine ambiguity', planPrompt.includes('genuine ambiguity'))
  t.check(
    'specific questions beat a full planning phase',
    planPrompt.includes(`prefer starting work and using AskUserQuestion`),
  )
  t.check('the aggressive "prefer planning" marker is gone', !planPrompt.includes('Prefer using EnterPlanMode'))
  t.check('the multi-file-count trigger is gone', !planPrompt.includes('more than 2-3 files'))
  t.check('the Mercury doctrine appendix survives', planPrompt.includes('Mercury doctrine (this harness)'))
  const promptSrc = readFileSync(join(ROOT, 'src/tools/EnterPlanModeTool/prompt.ts'), 'utf8')
  t.check('the zero-caller variant is deleted', !promptSrc.includes('getEnterPlanModeToolPromptAnt'))
}

t.section('§4 — one owner per clause (the attachment defers)')
{
  const attachmentSrc = readFileSync(join(ROOT, 'src/utils/messages/attachmentText.ts'), 'utf8')
  t.check(
    'the attachment points at the tool doctrine instead of duplicating it',
    attachmentSrc.includes('its usage notes carry the binding asking doctrine'),
  )
  t.check(
    'the duplicated never-ask bullet left the attachment',
    !attachmentSrc.includes('- Never ask what you could find out by reading the code'),
  )
  t.check(
    'the duplicated batching bullet left the attachment',
    !attachmentSrc.includes('Batch related questions together'),
  )
}

t.finish('prove-asking-doctrine')
