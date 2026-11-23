import { registerBundledSkill } from '../bundledSkills.js'
import { getSessionMemoryContent } from '../../services/SessionMemory/sessionMemoryUtils.js'
import { isCompactBoundaryMessage } from '../../utils/messages/systemMessages.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import type { Message } from '../../types/message.js'
import { passedOverAs } from '../../utils/passedOver.js'

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
  registerBundledSkill({
    name: 'skillify',
    description: "Capture this session's repeatable process as a reusable skill",
    argumentHint: '[what process to capture]',
    disableModelInvocation: true,
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      ASK_USER_QUESTION_TOOL_NAME,
      'Bash(mkdir *)',
    ],
    async getPromptForCommand(args, context) {
      const memory = await getSessionMemoryContent().catch(passedOverAs(null))
      const trimmed = args.trim()
      const descriptionLine =
        trimmed === '' ? '' : `\nThe user describes the process as: ${trimmed}`
      const memoryText =
        memory !== null
          ? memory
          : 'No session memory summary is available — derive the process from the user messages below.'
      const userTexts =
        collectUserMessages(context.messages) ||
        '(no user messages found after the last compaction)'
      const text = `Capture the repeatable process from this session as a reusable Mercury skill.${descriptionLine}

## Session memory
${memoryText}

## User messages since last compaction
${userTexts}

## Instructions
1. Review the session memory and user messages above to identify the concrete repeatable workflow, its inputs, its steps, and how success is verified.
2. Ask the user via ${ASK_USER_QUESTION_TOOL_NAME} to confirm the skill name, scope (project \`.mercury/skills/<name>/SKILL.md\` vs personal \`~/.mercury/skills/<name>/SKILL.md\`), arguments, and any ambiguous steps.
3. Draft the \`SKILL.md\` file using this template:

\`\`\`markdown
${TEMPLATE}\`\`\`

4. Confirm the final draft with the user via ${ASK_USER_QUESTION_TOOL_NAME} before writing, then create the skill directory and write \`SKILL.md\`.`
      return [{ type: 'text', text }]
    },
  })
}
