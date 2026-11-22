import { registerBundledSkill } from '../bundledSkills.js'
import { getSessionMemoryContent } from '../../services/SessionMemory/sessionMemoryUtils.js'
import { isCompactBoundaryMessage } from '../../utils/messages/systemMessages.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import type { Message } from '../../types/message.js'
import { passedOverAs } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

const MESSAGE_SEPARATOR = '\n---\n'

function collectUserMessages(messages: Message[]): string {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundaryMessage(messages[i]!)) {
      start = i + 1
      break
    }
  }
  const texts: string[] = []
  for (const message of messages.slice(start)) {
    if (message.type !== 'user') continue
    const content = message.message.content
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map(block => block.text)
            .join('\n')
    if (text.trim() !== '') texts.push(text)
  }
  return texts.join(MESSAGE_SEPARATOR)
}

const TEMPLATE = `---
name: <skill-name>
description: Use when <triggers and key phrases>. Not for <nearest confusable task>.
allowed-tools: <omit when only Read/Grep/Glob are used; otherwise minimum pattern-scoped grants>
argument-hint: <only when taking parameters; <required> or [optional]>
arguments: <only when taking parameters; $name substitutes in the body>
context: <fork only for self-contained runs needing no mid-process input>
---

## Inputs
<what the skill needs to start>

## Goal
<what done looks like>

## Steps
1. <step> — Success: <artefact or check proving it worked>
   1a/1b. <concurrent sub-steps>
2. [HUMAN] <person-performed step> — Success: <...>
`

export function registerSkillifySkill(): void {
  return notBuilt('src/skills/bundled/skillify.ts:55')
}
