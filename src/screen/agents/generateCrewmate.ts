import { routedCallModelSettled } from '../../models/roads/callModelRouter.js'
import { getEmptyToolPermissionContext } from '../../tools/kit/tool.js'
import { AGENT_TOOL_NAME } from '../../tools/kit/names/agent.js'
import { getUserContext } from '../../engine/requestContext.js'
import { isMnemeEnabled } from '../../sessions/mneme/paths.js'
import { prependUserContext } from '../../engine/messages/apiSystemAndToolSchema.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from '../../engine/messages/messages.js'
import { asSystemPrompt } from '../../engine/system-prompt/systemPromptType.js'

type GeneratedAgent = {
  identifier: string
  whenToUse: string
  systemPrompt: string
}

function draftingSystemPrompt(): string[] {
  const sections = [
    `You are an expert architect of agent configurations. Given a description of
what an agent should do, you design a complete, high-quality configuration
for it.

From the description, first extract the core intent: what the agent is for,
what it must and must not do, and what success looks like. Apply the
convention that a review agent reviews recently written code unless the
description says otherwise.

Then design:
- An expert persona for the agent, matched to the domain.
- Behavioural instructions as a SHORT set of principles, not an enumeration
  of cases: current Claude models follow a brief, reasoned instruction
  better than an exhaustive rule list, and over-prescription degrades their
  output. For each principle give the reason beside the rule, so the agent
  can generalize it instead of pattern-matching it.
- Explicit boundaries: what the agent must not do; when the deliverable is
  an assessment rather than a change; and when to escalate back to the
  caller — a destructive or irreversible action, a real scope change, or
  input only the caller can provide. Escalation means asking and ending the
  turn, never ending on a promise of work not done.
- Grounded reporting: the agent reports only what it can point to tool-result
  evidence for, states unverified work as unverified, and reports failures
  faithfully with their output. Once it has enough information to act, it
  acts — a recommendation, never an exhaustive survey of options.
- Output format: lead with the outcome in complete sentences written for a
  reader who did not watch the work; supporting detail after. Never include
  an instruction to echo, transcribe or explain the agent's own reasoning in
  its response — the answer is its findings, not its thinking.
- Self-verification where it genuinely helps: for substantial work, a check
  of the finished result against the request before reporting, stated
  briefly — not a mid-stream ritual.
- Alignment with the project's resolved repository instructions when they
  exist, and any requirements the user stated.
- An identifier built from lowercase letters, digits and hyphens — typically
  two to four hyphen-joined words — descriptive and memorable, avoiding
  generic words.

The "whenToUse" field must contain worked examples inside <example> blocks.
Each example contains a Context line, a user line, one or more assistant
lines, and a <commentary> block explaining the delegation. The examples must
show the assistant launching the agent through the ${AGENT_TOOL_NAME} tool
rather than answering directly.`,
    `Your output is a single valid JSON object with exactly these fields:
- "identifier": the agent's identifier as described above.
- "whenToUse": the delegation guidance with its <example> blocks.
- "systemPrompt": the complete system prompt for the agent, written in the
  second person.

Return the JSON object only — no prose before or after it.`,
    `When writing the generated system prompt, keep it specific to the described
purpose: name the concrete inputs the agent will see, state how it should
handle work outside its charter, and prefer short imperative instructions
over abstract qualities.`,
  ]
  if (isMnemeEnabled()) {
    sections.push(`When the description mentions memory, or the agent would naturally
accumulate knowledge across uses, include a short domain-specific section in
the system prompt on maintaining its memory: what is worth recording (stable
facts, corrections, recurring pitfalls in its domain), and what is not
(one-off details). Shape it to the agent's domain — a code reviewer records
recurring defect patterns, a data analyst records dataset quirks.`)
  }
  return sections
}

function readStringField(obj: object, key: string): string {
  const value: unknown = Reflect.get(obj, key)
  return typeof value === 'string' ? value : ''
}

export async function generateAgent(
  userPrompt: string,
  model: string,
  existingIdentifiers: string[],
  abortSignal: AbortSignal,
): Promise<GeneratedAgent> {
  let prompt = `Design an agent configuration for this request:\n\n${userPrompt}`
  if (existingIdentifiers.length > 0) {
    prompt += `\n\nThese identifiers are already taken and must not be reused: ${existingIdentifiers.join(', ')}`
  }
  prompt += '\n\nReturn the JSON object only.'

  const userContext = await getUserContext()
  const messages = normalizeMessagesForAPI(
    prependUserContext([createUserMessage({ content: prompt })], userContext),
  )

  const response = await routedCallModelSettled({
    messages,
    systemPrompt: asSystemPrompt(draftingSystemPrompt()),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: abortSignal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model,
      querySource: 'agent_creation',
      agents: [],
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  const text = response.message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end < start) {
      throw new Error('No JSON object found in the model response')
    }
    parsed = JSON.parse(text.slice(start, end + 1))
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('No JSON object found in the model response')
  }

  const identifier = readStringField(parsed, 'identifier')
  const whenToUse = readStringField(parsed, 'whenToUse')
  const systemPrompt = readStringField(parsed, 'systemPrompt')

  if (!identifier || !whenToUse || !systemPrompt) {
    throw new Error(
      'The generated agent configuration is missing identifier, whenToUse or systemPrompt',
    )
  }

  return { identifier, whenToUse, systemPrompt }
}
