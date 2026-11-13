import { registerBundledSkill } from '../bundledSkills.js'
import { getSessionMemoryContent } from '../../services/SessionMemory/sessionMemoryUtils.js'
import { isCompactBoundaryMessage } from '../../utils/messages/systemMessages.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import type { Message } from '../../types/message.js'

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
    description: 'Capture this session\'s repeatable process as a reusable skill',
    argumentHint: '[what process to capture]',
    disableModelInvocation: true,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', ASK_USER_QUESTION_TOOL_NAME, 'Bash(mkdir *)'],
    getPromptForCommand: async (args, context) => {
      const memory = await getSessionMemoryContent().catch(() => null)
      const userMessages = collectUserMessages(context.messages)
      const described = args.trim()
        ? `\nThe user describes the process as: ${args.trim()}`
        : ''
      const text = `Capture this session's repeatable process as a reusable skill.${described}

<session_memory>
${memory ?? 'No session memory summary is available — derive the process from the user messages below.'}
</session_memory>

<user_messages>
${userMessages || '(no user messages found after the last compaction)'}
</user_messages>

1. Analyse the session before asking anything: identify the repeatable process, inputs/parameters, ordered steps, per-step success artefacts, user corrections, tools/permissions used, and any crewmates used.

2. Interview the user strictly via ${ASK_USER_QUESTION_TOOL_NAME} (never plain-text questions) in up to four rounds, stopping early for simple processes (omit "needs tweaking" options — freeform is built in):
   - Round 1: skill name, description, goal, and success criteria.
   - Round 2: numbered steps, proposed arguments, inline vs \`context: fork\`, and save location (\`.mercury/skills/<name>/SKILL.md\` for the repo or \`~/.mercury/skills/<name>/SKILL.md\` for personal use).
   - Round 3: per-step artefacts, verification checks, confirmation gates before irreversible actions, parallelizable steps, execution mode (direct by default, crewmate, or human-performed), and hard constraints.
   - Round 4: trigger phrases, exclusions, and gotchas.

3. Draft \`SKILL.md\` from this template (keep \`description\` <= 250 chars with trigger first; require a \`Success:\` check on every step; keep simple skills concise):
${TEMPLATE}
4. Show the complete \`SKILL.md\` in a fenced block and confirm via ${ASK_USER_QUESTION_TOOL_NAME} before writing. Afterwards, report the saved path, invocation syntax, and that the file is directly editable.`
      return [{ type: 'text', text }]
    },
  })
}
