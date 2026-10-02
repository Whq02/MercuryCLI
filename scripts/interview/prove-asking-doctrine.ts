#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()

const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')

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

t.finish('prove-asking-doctrine')
