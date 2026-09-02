// ============================================================================
//  src/skills/bundled/skillify.ts — /skillify: capture this session's
//  repeatable process as a reusable SKILL.md through a question-tool
//  interview.
// ============================================================================
import { registerBundledSkill } from '../bundledSkills.js'
import { getSessionMemoryContent } from '../../services/SessionMemory/sessionMemoryUtils.js'
import { isCompactBoundaryMessage } from '../../utils/messages/systemMessages.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import type { Message } from '../../types/message.js'

const MESSAGE_SEPARATOR = '\n---\n'

/** User messages after the last compaction boundary, flattened to text. */
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
description: <one-line description>
allowed-tools: <minimum necessary, pattern-scoped rather than whole-tool>
when_to_use: Use when <trigger conditions; include trigger phrases>
argument-hint: <only when the skill takes parameters>
arguments: <only when the skill takes parameters; $name substitutes in the body>
context: <fork only for self-contained skills needing no mid-process input>
---

## Inputs
<what the skill needs to start>

## Goal
<what done looks like>

## Steps
1. <step> — Success: <the artefact or check proving this step worked>
2. <step> — Success: <...>
   2a/2b. <concurrent sub-steps use sub-numbering>
3. [HUMAN] <steps a person performs are marked in the title>
`

export function registerSkillifySkill(): void {
  registerBundledSkill({
    name: 'skillify',
    description: 'Capture this session\'s repeatable process as a reusable skill',
    argumentHint: '[what process to capture]',
    disableModelInvocation: true,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', ASK_USER_QUESTION_TOOL_NAME, 'Bash(mkdir:*)'],
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

FIRST, before asking anything, analyse the session: the repeatable process; its inputs and parameters; the ordered steps; the artefact proving each step succeeded; where the user corrected or steered you; the tools and permissions used; any agents used.

THEN interview the user ENTIRELY through the ${ASK_USER_QUESTION_TOOL_NAME} tool — never ask via plain text — across up to four rounds:
1. Confirm the skill name and description, the high-level goal, and the success criteria.
2. Present the identified steps as a numbered list; propose arguments; ask inline-versus-forked execution and where to save.
3. Per-step detail: the artefacts later steps need, the proof of success, whether to confirm before proceeding (especially for irreversible actions), which steps can run in parallel, the execution mechanism, and hard constraints.
4. When the skill should be invoked, trigger phrases, and remaining gotchas.
Iterate with more rounds when needed; stop early for simple processes. Do not add your own "needs tweaking" option — the question tool always offers a freeform alternative.

Save-location options to offer: the repository path .mercury/skills/<name>/SKILL.md, or the personal path ~/.mercury/skills/<name>/SKILL.md.

Write the SKILL.md using this template:
${TEMPLATE}
Template rules: SUCCESS CRITERIA ARE REQUIRED ON EVERY STEP. Optional per-step annotations: execution mode (direct by default; task agent; teammate; human-performed), produced artefacts, human checkpoints, hard rules. Concurrent steps use sub-numbering; human steps are marked in the title. Simple skills stay simple. allowed-tools is the minimum necessary, pattern-scoped rather than whole-tool. context: fork is only for self-contained skills needing no mid-process input. when_to_use is critical: start it with "Use when" and include trigger phrases. The arguments fields appear only when the skill takes parameters, with $name substitution in the body.

Before writing: output the complete file content for review as a fenced code block, then confirm via the ${ASK_USER_QUESTION_TOOL_NAME} tool with a concise question. After writing: tell the user where it was saved, how to invoke it, and that they can edit the file directly.`
      return [{ type: 'text', text }]
    },
  })
}
