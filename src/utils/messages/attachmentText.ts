// Attachment → API-message projection — the attachment-type switch
// (normalizeAttachmentForAPI) plus the mode-instruction builders (strategy /
// interview / flow / supercode) and their prompt templates. Owned Mercury
// module .
//
// Template discipline: every string here is model-facing wire bytes, pinned
// by the parity oracle (scripts/messages — regenerate with --record in the
// SAME cut as any template change) and by prompt-cache stability (a one-byte
// drift is one cache miss per changed attachment on the first turn after an
// upgrade). Mechanism tokens — the <system-reminder> envelope (owned by the
// wrappers), wire tag names like <mcp-resource>, the capsule-digest line —
// are protocol, not prose: they never change in a wording pass.

import { boundHookContext, boundSeamContext } from '../hooks/contextBound.js'
import { sliceHeadAtGrapheme } from '../intl.js'
import type { ContentBlockParam, TextBlockParam } from '../../types/wire.js'
import { MERCURY_SCOUT_AGENT } from 'src/tools/AgentTool/built-in/mercuryScoutAgent.js'
import { MERCURY_ARCHITECT_AGENT } from 'src/tools/AgentTool/built-in/mercuryArchitectAgent.js'

import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import {
  FILE_READ_TOOL_NAME,
  MAX_LINES_TO_READ,
} from 'src/tools/FileReadTool/prompt.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { DiagnosticTrackingService } from '../../services/diagnosticTracking.js'
import { type AnyObject, type Tool } from '../../Tool.js'
import {
  FileReadTool,
  type Output as FileReadToolOutput,
} from '../../tools/FileReadTool/FileReadTool.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../../tools/TaskOutputTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import type { MessageOrigin, UserMessage } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { type Attachment, memoryHeader } from '../attachments.js'
import { quote } from '../bash/shellQuote.js'
import { getCurrentProjectConfig } from '../config.js'
import { logAntError } from '../debug.js'
import { hasEmbeddedSearchTools } from '../embeddedTools.js'
import { formatFileSize, formatNumber } from '../format.js'
import { logMCPDebug } from '../log.js'
import {
  getPewterLedgerVariant,
  getPlanModeV2AgentCount,
  getPlanModeV2ExploreAgentCount,
  isPlanModeInterviewPhaseEnabled,
} from '../planModeV2.js'
import { jsonStringify } from '../slowOperations.js'
import { isTodoV2Enabled } from '../tasks.js'
import {
  formatDecisionRecordForPlanning,
  latestDecisionRecordSync,
} from '../../services/interview/decisionRecord.js'
import { createUserMessage } from './factories.js'
import {
  wrapCommandText,
  wrapInSystemReminder,
  wrapMessagesInSystemReminder,
} from './text.js'

// Deferred require: teammateMailbox's import chain leads back into
// messages, so a top-level import here would close a cycle.
function getTeammateMailbox(): typeof import('../teammateMailbox.js') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the cycle-breaking lazy load above
  return require('../teammateMailbox.js')
}

function getPlanModeInstructions(attachment: {
  reminderType: 'full' | 'sparse'
  isSubAgent?: boolean
  planFilePath: string
  planExists: boolean
}): UserMessage[] {
  if (attachment.isSubAgent) {
    return getPlanModeV2SubAgentInstructions(attachment)
  }
  if (attachment.reminderType === 'sparse') {
    return getPlanModeV2SparseInstructions(attachment)
  }
  return getPlanModeV2Instructions(attachment)
}

//
// Plan-file structure experiment arms (the pewter-ledger variants). Each
// arm is the COMPLETE Phase 4 section, so the surrounding template splices
// one flat string and carries no inline conditionals.

export const PLAN_PHASE4_CONTROL = `### Phase 4: Final Plan
Goal: finish the plan file (still the only file you may edit).
- Open with a **Context** section: the problem or need behind the change, what prompted it, and the outcome it should produce
- Present one recommended approach — alternatives you rejected stay out
- Keep the file scannable in a minute yet concrete enough to execute from
- Name the critical files the work will touch
- Point at the existing functions and utilities you found worth reusing, each with its file path
- Close with a verification section: how to prove the change works end to end (run the code, drive MCP tools, run the tests)`

const PLAN_PHASE4_TRIM = `### Phase 4: Final Plan
Goal: finish the plan file (still the only file you may edit).
- **Context** in one line: what changes and why
- Present one recommended approach — alternatives stay out
- List the files the work will touch
- Point at the existing functions and utilities worth reusing, with file paths
- Close with **Verification**: the one command that proves the change works (no numbered test procedures)`

const PLAN_PHASE4_CUT = `### Phase 4: Final Plan
Goal: finish the plan file (still the only file you may edit).
- No Context or Background section — the user just told you what they want
- One line per file: which file, what changes in it
- Point at the existing functions and utilities worth reusing, with file paths
- Close with **Verification**: the one command that proves the change works
- Most good plans fit in 40 lines; prose past that is padding`

const PLAN_PHASE4_CAP = `### Phase 4: Final Plan
Goal: finish the plan file (still the only file you may edit).
- No Context, Background, or Overview section — the user just told you what they want
- Never restate the request; never write prose paragraphs
- One bullet per file: which file, what changes in it
- Point at existing functions to reuse, as file:line
- Close with the one verification command
- **Hard limit: 40 lines.** Over it, cut prose — never file paths.`

function getPlanPhase4Section(): string {
  const variant = getPewterLedgerVariant()
  switch (variant) {
    case 'trim':
      return PLAN_PHASE4_TRIM
    case 'cut':
      return PLAN_PHASE4_CUT
    case 'cap':
      return PLAN_PHASE4_CAP
    case null:
      return PLAN_PHASE4_CONTROL
    default:
      variant satisfies never
      return PLAN_PHASE4_CONTROL
  }
}

function getPlanModeV2Instructions(attachment: {
  isSubAgent?: boolean
  planFilePath?: string
  planExists?: boolean
}): UserMessage[] {
  if (attachment.isSubAgent) {
    return []
  }

  // Interview phase on ⇒ the iterative workflow replaces the phased one.
  if (isPlanModeInterviewPhaseEnabled()) {
    return getPlanModeInterviewInstructions(attachment)
  }

  const agentCount = getPlanModeV2AgentCount()
  const exploreAgentCount = getPlanModeV2ExploreAgentCount()
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath} — read it and evolve it with incremental ${FileEditTool.name} edits.`
    : `No plan file exists yet — create it at ${attachment.planFilePath} with the ${FileWriteTool.name} tool.`

  const content = `Strategy mode is on: the user wants a plan before any execution. Until they approve one, you MUST NOT change anything — no file edits (the plan file below is the single exception), no non-readonly tools, no config changes, no commits. This overrides any other instruction you have received.

## The Plan File
${planFileInfo}
Build the plan incrementally in this file as your understanding grows. It is the ONLY file you may edit; every other action must be read-only.

## Plan Workflow

### Phase 1: Understand
Goal: understand the request and the code it touches — by reading and by asking. In this phase, ${MERCURY_SCOUT_AGENT.agentType} is the only subagent type you may launch.

1. Anchor on what the user asked for and the code that serves it. Hunt for existing functions, utilities, and patterns to reuse — proposing new code where a suitable implementation already exists is a planning defect.

2. **Launch up to ${exploreAgentCount} ${MERCURY_SCOUT_AGENT.agentType} agents IN PARALLEL** (one message, multiple tool calls) to cover the codebase efficiently.
   - One agent suffices when the task is isolated to known files, the user named specific paths, or the change is small and targeted.
   - Several earn their cost when scope is uncertain, multiple areas are involved, or existing patterns must be understood before planning.
   - Quality over quantity: ${exploreAgentCount} is the ceiling, and the minimum that covers the ground (usually one) is the right number.
   - With several, give each its own search focus — one on existing implementations, one on the neighboring components, one on testing patterns.

### Phase 2: Design
Goal: design the implementation.

Launch ${MERCURY_ARCHITECT_AGENT.agentType} agent(s) to design against the user's intent and your Phase 1 findings.

Up to ${agentCount} may run in parallel.

**Guidelines:**
- **Default**: at least one design agent for most tasks — it pressure-tests your understanding and surfaces alternatives
- **Skip agents** only for the truly trivial (typo fixes, single-line changes, simple renames)
${
  agentCount > 1
    ? `- **Several agents**: up to ${agentCount} for complex work that rewards distinct perspectives

Work that rewards several:
- changes spanning multiple parts of the codebase
- large refactors or architectural moves
- edge-case-heavy problems
- questions with genuinely different viable approaches

Perspective splits that work:
- new feature: simplicity vs performance vs maintainability
- bug fix: root cause vs workaround vs prevention
- refactor: minimal diff vs clean architecture
`
    : ''
}
In each agent's prompt:
- carry the Phase 1 context over in full — filenames and code-path traces included
- state the requirements and constraints
- ask for a concrete implementation plan

### Phase 3: Review
Goal: check the Phase 2 output against what the user actually asked for.
1. Read the critical files the agents named — deepen your own picture
2. Confirm the plan serves the original request
3. Put any open questions to the user through ${ASK_USER_QUESTION_TOOL_NAME}

${getPlanPhase4Section()}

### Phase 5: Call ${ExitPlanModeV2Tool.name}
When the questions are asked and the plan file satisfies you, end your turn by calling ${ExitPlanModeV2Tool.name} — that is how the user learns planning is done.
This is binding: a turn in this workflow ends ONLY by using ${ASK_USER_QUESTION_TOOL_NAME} or by calling ${ExitPlanModeV2Tool.name}. No other stopping point exists.

**Important:** ${ASK_USER_QUESTION_TOOL_NAME} is for clarifying requirements and choosing between approaches — nothing else. Plan APPROVAL goes through ${ExitPlanModeV2Tool.name}, never through prose and never through AskUserQuestion. "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?" — every phrase of that shape MUST be ${ExitPlanModeV2Tool.name} instead.

Throughout the workflow, ask the user whenever intent is genuinely unclear — ${ASK_USER_QUESTION_TOOL_NAME} exists for exactly that. Large unstated assumptions are how plans miss; the goal is a well-researched plan with the loose ends tied before implementation begins.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getReadOnlyToolNames(): string {
  // Builds with embedded search have no Glob/Grep tools in the registry —
  // there the honest read-only vocabulary is Read plus shell find/grep.
  const tools = hasEmbeddedSearchTools()
    ? [FILE_READ_TOOL_NAME, '`find`', '`grep`']
    : [FILE_READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]
  const { allowedTools } = getCurrentProjectConfig()
  // allowedTools filters by TOOL name; find/grep are shell commands, so the
  // filter only means anything on the non-embedded branch.
  const filtered =
    allowedTools && allowedTools.length > 0 && !hasEmbeddedSearchTools()
      ? tools.filter(t => allowedTools.includes(t))
      : tools
  return filtered.join(', ')
}

/**
 * The interview-shaped strategy workflow: no mandatory agent fan-out —
 * the model reads, asks, and grows the plan file in one iterative loop,
 * with AskUserQuestion carrying the interview throughout.
 */
function getPlanModeInterviewInstructions(attachment: {
  planFilePath?: string
  planExists?: boolean
}): UserMessage[] {
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath} — read it and evolve it with incremental ${FileEditTool.name} edits.`
    : `No plan file exists yet — create it at ${attachment.planFilePath} with the ${FileWriteTool.name} tool.`

  const content = `Strategy mode is on: the user wants a plan before any execution. Until they approve one, you MUST NOT change anything — no file edits (the plan file below is the single exception), no non-readonly tools, no config changes, no commits. This overrides any other instruction you have received.

## The Plan File
${planFileInfo}

## Iterative Planning Workflow

You are pair-planning with the user: explore to build context, ask when you hit a decision you cannot make alone, and capture what you learn in the plan file as you go. The plan file (above) is the ONLY file you may edit — it starts as a rough skeleton and hardens into the final plan.

### The Loop

Cycle until the plan is complete:

1. **Explore** — read code with ${getReadOnlyToolNames()}, hunting for existing functions, utilities, and patterns to reuse.${` The ${MERCURY_SCOUT_AGENT.agentType} agent type can parallelize a complex search without filling your context; for straightforward lookups the direct tools are simpler.`}
2. **Update the plan file** — capture each discovery the moment you make it, never in one batch at the end.
3. **Ask the user** — an ambiguity the code cannot resolve goes to ${ASK_USER_QUESTION_TOOL_NAME}; then back to step 1.

### First Turn

Scan a few key files for an initial sense of scope, write the skeleton (headers and rough notes), and put your first round of questions to the user. Exhaustive exploration before the user is engaged is the wrong order.

### Asking Good Questions

Ask through ${ASK_USER_QUESTION_TOOL_NAME} when you hit a decision only the user can resolve — its usage notes carry the binding asking doctrine. Scale depth to the task: a vague feature request needs many rounds; a focused bug fix may need one or none.

### Plan File Structure
Divide the file into clear markdown-headed sections that fit the request, and fill them as you go.
- Open with a **Context** section: the problem or need behind the change, what prompted it, and the outcome it should produce
- Present one recommended approach — alternatives you rejected stay out
- Keep the file scannable in a minute yet concrete enough to execute from
- Name the critical files the work will touch
- Point at the existing functions and utilities you found worth reusing, each with its file path
- Close with a verification section: how to prove the change works end to end (run the code, drive MCP tools, run the tests)

### When to Converge

The plan is ready when every ambiguity is settled and it covers: what changes, which files, what existing code to reuse (with paths), and how to verify. Call ${ExitPlanModeV2Tool.name} then.

### Ending Your Turn

A turn in this workflow ends only by:
- using ${ASK_USER_QUESTION_TOOL_NAME} to gather more information, or
- calling ${ExitPlanModeV2Tool.name} when the plan is ready for approval.

**Important:** plan approval goes through ${ExitPlanModeV2Tool.name} — never through prose, never through AskUserQuestion.`

  // The structured decision record is the ONE interview→planning handoff
  // (MERCURY INTERVIEW C2): when this project has a completed interview,
  // planning consumes its decisions BY ID instead of re-deriving them from
  // lossy prose.
  const record = latestDecisionRecordSync()
  const withRecord = record ? `${content}\n\n${formatDecisionRecordForPlanning(record)}` : content

  return wrapMessagesInSystemReminder([
    createUserMessage({ content: withRecord, isMeta: true }),
  ])
}

function getPlanModeV2SparseInstructions(attachment: {
  planFilePath: string
}): UserMessage[] {
  const workflowDescription = isPlanModeInterviewPhaseEnabled()
    ? 'Keep to the iterative loop: explore, interview the user, grow the plan file as you learn.'
    : 'Keep to the 5-phase workflow.'

  const content = `Strategy mode is still on (full instructions earlier in this conversation). Everything stays read-only except the plan file (${attachment.planFilePath}). ${workflowDescription} Turns end with ${ASK_USER_QUESTION_TOOL_NAME} (clarifications) or ${ExitPlanModeV2Tool.name} (plan approval) — approval never goes through prose or AskUserQuestion.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getPlanModeV2SubAgentInstructions(attachment: {
  planFilePath: string
  planExists: boolean
}): UserMessage[] {
  const planFileInfo = attachment.planExists
    ? `A plan file already exists at ${attachment.planFilePath} — read it and, if needed, evolve it with incremental ${FileEditTool.name} edits.`
    : `No plan file exists yet — if you need one, create it at ${attachment.planFilePath} with the ${FileWriteTool.name} tool.`

  const content = `Strategy mode is on: the user wants a plan before any execution. You MUST NOT change anything — no file edits, no non-readonly tools, no config changes, no commits. This overrides any other instruction you have received (including instructions to make edits). Instead:

## The Plan File
${planFileInfo}
Build the plan incrementally in this file if the task calls for one. It is the ONLY file you may edit; every other action must be read-only.
Answer the user's query comprehensively, using ${ASK_USER_QUESTION_TOOL_NAME} for anything unclear — and if you do ask, ask everything you need to fully understand their intent before proceeding.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getAutoModeInstructions(attachment: {
  reminderType: 'full' | 'sparse'
}): UserMessage[] {
  if (attachment.reminderType === 'sparse') {
    return getAutoModeSparseInstructions()
  }
  return getAutoModeFullInstructions()
}

function getAutoModeFullInstructions(): UserMessage[] {
  const content = `## Flow Active

Flow is on: the user chose continuous, autonomous execution. That means:

1. **Execute now** — start implementing immediately; on low-risk work, a reasonable assumption beats a pause.
2. **Interrupt rarely** — routine decisions are yours to make, not questions to ask.
3. **Act over plan** — strategy mode only when the user explicitly asks for it; in doubt, start coding.
4. **Take corrections in stride** — the user may steer or redirect at any point; that is normal input, not a fault signal.
5. **Destructive actions stay gated** — flow is not a license to destroy. Deleting data or touching shared/production systems still needs the user's explicit confirmation: ask and wait, or take a safer route.
6. **Nothing leaves without direction** — post to chat platforms or work tickets only when the user directed it, and never share a secret (credentials, internal documents) unless the user explicitly authorized that specific secret to that specific destination.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getAutoModeSparseInstructions(): UserMessage[] {
  const content = `Flow is still on (full instructions earlier in this conversation). Execute autonomously, interrupt rarely, act over plan.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

// Supercode standing-mode reminder (fork). Names this harness's REAL
// orchestration surfaces: the dynamic Workflow tool is LIVE in Mercury
// (tools.ts registers it unconditionally — the full
// engine graph ships and runs; see WorkflowTool.tsx GATE note), so the doctrine
// is Workflow-first, with the Agent tool for a
// single focused worker and LaunchFleet for teammate fan-out as the
// alternatives. (An earlier revision predated the workflow port and steered
// AWAY from Workflow — that staleness suppressed the whole dynamic-workflow
// surface while supercode was on.)
function getUltraEffortInstructions(attachment: {
  reminderType: 'full' | 'sparse'
}): UserMessage[] {
  if (attachment.reminderType === 'sparse') {
    return getUltraEffortSparseInstructions()
  }
  return getUltraEffortFullInstructions()
}

function getUltraEffortFullInstructions(): UserMessage[] {
  const content = `## Supercode is on

The user opted this session into supercode: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Token cost is not a constraint. This opt-in is standing until it is turned off.

1. **Be exhaustive and correct** — prefer thoroughness over brevity; verify your work and close loops rather than stopping at the first plausible answer.
2. **Orchestrate by default for substantive work** — author and run a dynamic Workflow (the Workflow tool: agent()/parallel()/pipeline() scripts) for anything multi-part: understand → design → implement → review. Decompose the task and fan out where independent work allows, then synthesize. Reach for a single Agent-tool subagent when one focused worker suffices, or LaunchFleet for teammate fan-out. Solo only conversational/trivial turns.
3. **Stay in the loop between phases** — multi-phase work often means several workflows in sequence (one per phase) so you review and steer between them, rather than one giant unsupervised run.
4. **Adversarially verify** — have work checked (a reviewer pass, a completeness critic, a re-derivation) before declaring it done; loop until the checks come back clean.
5. **No new risk license** — exhaustiveness is not a license for destructive or outward-facing actions; those still need the usual confirmation.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

function getUltraEffortSparseInstructions(): UserMessage[] {
  const content = `Supercode is still on (see the full instructions earlier in this conversation). Keep optimizing for the most exhaustive, correct answer; author Workflow scripts (or subagents/fleets) for substantive work; solo only trivial turns.`

  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}

export function normalizeAttachmentForAPI(
  attachment: Attachment,
): UserMessage[] {
  if (isAgentSwarmsEnabled()) {
    if (attachment.type === 'teammate_mailbox') {
      // The inbox is a FILE any process can write — each message body rides
      // the seam bound so a flooded inbox (or a runaway teammate) cannot
      // wedge the session; the marker names the spill file per message.
      const boundedMessages = attachment.messages.map(message => ({
        ...message,
        text: boundSeamContext(message.text, `teammate-${message.from}`).text,
      }))
      return [
        createUserMessage({
          content: getTeammateMailbox().formatTeammateMessages(boundedMessages),
          isMeta: true,
        }),
      ]
    }
    if (attachment.type === 'team_context') {
      return [
        createUserMessage({
          content: `<system-reminder>
# Team Coordination

You are a teammate in team "${attachment.teamName}".

**Your Identity:**
- Name: ${attachment.agentName}

**Team Resources:**
- Team config: ${attachment.teamConfigPath}
- Task list: ${attachment.taskListPath}

**Team Leader:** the lead's name is "team-lead" — updates and completion notifications go to them.

The team config lists your teammates' names. Check the task list periodically; create tasks when work should be divided, and mark yours resolved when complete.

**IMPORTANT:** teammates are addressed by NAME ("team-lead", "analyzer", "researcher"), never by UUID:

\`\`\`json
{
  "to": "team-lead",
  "message": "Your message here",
  "summary": "Brief 5-10 word preview"
}
\`\`\`
</system-reminder>`,
          isMeta: true,
        }),
      ]
    }
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- teammate_mailbox/team_context are handled above the switch (their literals stay inside the isAgentSwarmsEnabled() guard); retired types fall through to the legacy sink below
  // biome-ignore lint/nursery/useExhaustiveSwitchCases: teammate_mailbox/team_context handled above the switch; retired types fall through to the legacy sink below
  switch (attachment.type) {
    case 'directory': {
      return wrapMessagesInSystemReminder([
        createToolUseMessage(BashTool.name, {
          command: `ls ${quote([attachment.path])}`,
          description: `Lists files in ${attachment.path}`,
        }),
        createToolResultMessage(BashTool, {
          stdout: attachment.content,
          stderr: '',
          interrupted: false,
        }),
      ])
    }
    case 'edited_text_file':
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `${attachment.filename} changed outside this conversation — the user or a linter edited it. The change is intentional: work with it, and never revert it unless the user asks. Do not mention it to the user; they already know. The relevant changes (with line numbers):\n${attachment.snippet}`,
          isMeta: true,
        }),
      ])
    case 'file': {
      const fileContent = attachment.content as FileReadToolOutput
      switch (fileContent.type) {
        case 'image': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
        case 'text': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
            ...(attachment.truncated
              ? [
                  createUserMessage({
                    content: `${attachment.filename} was too large — only its first ${MAX_LINES_TO_READ} lines are shown above. Read further with ${FileReadTool.name} when you need more; do not mention the truncation to the user.`,
                    isMeta: true, // model-facing only
                  }),
                ]
              : []),
          ])
        }
        case 'notebook': {
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
        case 'pdf': {
          // The PDF bytes ride the tool result's supplementalContent.
          return wrapMessagesInSystemReminder([
            createToolUseMessage(FileReadTool.name, {
              file_path: attachment.filename,
            }),
            createToolResultMessage(FileReadTool, fileContent),
          ])
        }
      }
      break
    }
    case 'compact_file_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `${attachment.filename} was read before the conversation was summarized, and its contents are too large to carry across. Re-read it with ${FileReadTool.name} when you need it.`,
          isMeta: true,
        }),
      ])
    }
    case 'pdf_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            `PDF: ${attachment.filename} (${attachment.pageCount} pages, ${formatFileSize(attachment.fileSize)}) — too large to read in one pass. ` +
            `Read it through ${FILE_READ_TOOL_NAME} with the pages parameter, in ranges (e.g. pages: "1-5"); a call WITHOUT pages will fail on this file. ` +
            `Start with the first few pages to learn the structure, then pull more as needed — at most 20 pages per request.`,
          isMeta: true,
        }),
      ])
    }
    case 'selected_lines_in_ide': {
      const maxSelectionLength = 2000
      const content =
        attachment.content.length > maxSelectionLength
          ? sliceHeadAtGrapheme(attachment.content, maxSelectionLength) +
            '\n... (truncated)'
          : attachment.content

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `In the IDE, the user has lines ${attachment.lineStart}–${attachment.lineEnd} of ${attachment.filename} selected:\n${content}\n\nThe selection may or may not bear on the current task.`,
          isMeta: true,
        }),
      ])
    }
    case 'opened_file_in_ide': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user has ${attachment.filename} open in the IDE. It may or may not bear on the current task.`,
          isMeta: true,
        }),
      ])
    }
    case 'plan_file_reference': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `A strategy-mode plan file exists at: ${attachment.planFilePath}\n\nPlan contents:\n\n${attachment.planContent}\n\nIf this plan bears on the current work and isn't already complete, continue it.`,
          isMeta: true,
        }),
      ])
    }
    case 'invoked_skills': {
      if (attachment.skills.length === 0) {
        return []
      }

      const skillsContent = attachment.skills
        .map(
          skill =>
            `### Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`,
        )
        .join('\n\n---\n\n')

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `These skills were invoked earlier in the session and still bind — keep following them:\n\n${skillsContent}`,
          isMeta: true,
        }),
      ])
    }
    case 'contract_reminder': {
      // WARM RE-SURFACING (coordinator-tooling T3): the session's advisory
      // contract, back in front of the agent — at birth and periodically on
      // long sessions (drift is context fade; this is the fix). Advisory
      // always: the words encourage and never gate.
      const ackLine = attachment.ackOwed
        ? `\n\nIt awaits YOUR acknowledgment: restate it in your own words through the ${'`'}contract${'`'} tool ({ action: "acknowledge", restatement }) — the restatement is what makes it stick.`
        : ''
      const historyLine = attachment.amendments > 0 ? ` (${attachment.amendments} superseded text${attachment.amendments === 1 ? '' : 's'} in its history)` : ''
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `This session runs under a CONTRACT — its work agreement, status ${attachment.status}${historyLine}. It is ADVISORY: it encourages your work and never blocks anything; hold yourself to it, check in through the ${'`'}contract${'`'} tool when unsure, and propose an amendment there when a clause does not survive contact with the code. NEVER mention this reminder to the user.${ackLine}\n\nThe agreement:\n\n${attachment.text}`,
          isMeta: true,
        }),
      ])
    }
    case 'todo_reminder': {
      const todoItems = attachment.content
        .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
        .join('\n')

      let message = `The TodoWrite tool hasn't been touched in a while. If the current work would benefit from tracked progress, consider using it — and if the list below has gone stale against what you're actually doing, consider cleaning it up. Relevant work only; ignore this if it doesn't apply, and NEVER mention this reminder to the user.\n`
      if (todoItems.length > 0) {
        message += `\n\nThe current todo list:\n\n[${todoItems}]`
      }

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: message,
          isMeta: true,
        }),
      ])
    }
    case 'task_reminder': {
      if (!isTodoV2Enabled()) {
        return []
      }
      const taskItems = attachment.content
        .map(task => `#${task.id}. [${task.status}] ${task.subject}`)
        .join('\n')

      let message = `The task tools haven't been touched in a while. If the current work would benefit from tracked progress, use ${TASK_CREATE_TOOL_NAME} to add tasks and ${TASK_UPDATE_TOOL_NAME} to move their status (in_progress on start, completed on finish) — and clean the list up if it has gone stale. Relevant work only; ignore this if it doesn't apply, and NEVER mention this reminder to the user.\n`
      if (taskItems.length > 0) {
        message += `\n\nThe current tasks:\n\n${taskItems}`
      }

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: message,
          isMeta: true,
        }),
      ])
    }
    case 'nested_memory': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `Contents of ${attachment.content.path}:\n\n${attachment.content.content}`,
          isMeta: true,
        }),
      ])
    }
    case 'relevant_memories': {
      return wrapMessagesInSystemReminder(
        attachment.memories.map(m => {
          // The header was frozen at attachment creation, and rendering the
          // FROZEN copy keeps the bytes turn-stable (prompt-cache hits);
          // recomputation is only the fallback for resumed sessions older
          // than the stored-header field.
          const header = m.header ?? memoryHeader(m.path, m.mtimeMs)
          return createUserMessage({
            content: `${header}\n\n${m.content}`,
            isMeta: true,
          })
        }),
      )
    }
    case 'dynamic_skill': {
      // UI-only notice; the skill content itself loads through the Skill
      // tool, never through this projection.
      return []
    }
    case 'skill_listing': {
      // The removal arm mirrors the three sibling deltas (FN-013 MCP-01):
      // a de-applied skill is ANNOUNCED, never discovered by a failing
      // call. removedNames is optional-chained because persisted listings
      // predate the field.
      const parts: string[] = []
      if (attachment.content) {
        parts.push(
          `The following skills are available for use with the Skill tool:\n\n${attachment.content}`,
        )
      }
      // The degradation note (FN-013 MCP-05): the description is the
      // entire selection signal, so its loss is STATED, one line, with the
      // recovery path named.
      const truncation = attachment.truncation
      if (truncation && (truncation.nameOnly > 0 || truncation.withheld > 0)) {
        const bits: string[] = []
        if (truncation.nameOnly > 0) {
          bits.push(
            `${truncation.nameOnly} of the entries above list name-only (the catalogue budget was reached); each skill's full description is available on invocation`,
          )
        }
        if (truncation.withheld > 0) {
          bits.push(`${truncation.withheld} further skill name(s) were withheld entirely`)
        }
        parts.push(`Note: ${bits.join('; ')}.`)
      }
      if ((attachment.removedNames?.length ?? 0) > 0) {
        parts.push(
          `The following skills are no longer available (dialled off or removed). Do not invoke them — the Skill tool will refuse:\n${attachment.removedNames!.join('\n')}`,
        )
      }
      if (parts.length === 0) {
        return []
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: parts.join('\n\n'),
          isMeta: true,
        }),
      ])
    }
    case 'queued_command': {
      // The queue's explicit origin wins; task notifications predate the
      // origin field and reconstruct theirs from commandMode.
      const origin: MessageOrigin | undefined =
        attachment.origin ??
        (attachment.commandMode === 'task-notification'
          ? { kind: 'task-notification' }
          : undefined)

      // Transcript visibility law: only SYSTEM-generated queue entries hide.
      // Human input drained mid-turn carries no origin and no
      // QueuedCommand.isMeta and must render — an earlier hardcoded
      // isMeta:true made user-typed messages vanish in brief mode
      // (filterForBriefTool) and normal mode (shouldShowUserMessage) alike.
      const metaProp =
        origin !== undefined || attachment.isMeta
          ? ({ isMeta: true } as const)
          : {}

      if (Array.isArray(attachment.prompt)) {
        // Block-array prompt: text folds into the wrapped command text,
        // image blocks ride beside it untouched.
        const textContent = attachment.prompt
          .filter((block): block is TextBlockParam => block.type === 'text')
          .map(block => block.text)
          .join('\n')

        const imageBlocks = attachment.prompt.filter(
          block => block.type === 'image',
        )

        const content: ContentBlockParam[] = [
          {
            type: 'text',
            text: wrapCommandText(textContent, origin),
          },
          ...imageBlocks,
        ]

        return wrapMessagesInSystemReminder([
          createUserMessage({
            content,
            ...metaProp,
            origin,
            uuid: attachment.source_uuid,
          }),
        ])
      }

      // String prompt
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: wrapCommandText(String(attachment.prompt), origin),
          ...metaProp,
          origin,
          uuid: attachment.source_uuid,
        }),
      ])
    }
    case 'diagnostics': {
      if (attachment.files.length === 0) return []

      // One formatter owns diagnostic rendering — no local copy.
      const diagnosticSummary =
        DiagnosticTrackingService.formatDiagnosticsSummary(attachment.files)

      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `<new-diagnostics>The following new diagnostic issues were detected:\n\n${diagnosticSummary}</new-diagnostics>`,
          isMeta: true,
        }),
      ])
    }
    case 'plan_mode': {
      return getPlanModeInstructions(attachment)
    }
    case 'plan_mode_reentry': {
      const content = `## Re-entering Strategy Mode

You have been in strategy mode before this session, and the plan file from that pass still exists at ${attachment.planFilePath}.

**Before any new planning:**
1. Read the existing plan file — know what was planned last time
2. Weigh the user's current request against it
3. Choose the relationship:
   - **Different task** (even a similar or related one): start clean by overwriting the old plan
   - **Same task, continuing**: evolve the existing plan, pruning sections the work has outgrown
4. Then run the plan process as usual — and whichever way you chose, the plan file must be edited before ${ExitPlanModeV2Tool.name} is called

This is a fresh planning session: the old plan earns relevance by evaluation, never by assumption.`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'plan_mode_exit': {
      const planReference = attachment.planExists
        ? ` The plan file remains at ${attachment.planFilePath} for reference.`
        : ''
      const content = `## Exited Strategy Mode

Strategy mode is over: edits, tools, and actions are all available again.${planReference}`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'auto_mode': {
      return getAutoModeInstructions(attachment)
    }
    case 'auto_mode_exit': {
      const content = `## Exited Flow

Flow is off — the user likely wants a more interactive pace again. Where the approach is ambiguous, ask a clarifying question rather than assuming.`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'mode_pack': {
      // The pack's bytes were captured when the mode was entered; the row
      // replays them unchanged.
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.text, isMeta: true }),
      ])
    }
    case 'mode_pack_exit': {
      const label = attachment.mode === 'apollo' ? 'Apollo mode' : 'Autopilot'
      const content = `## Exited ${label}

${label} is off: its instructions above no longer apply, and the session's standing instructions govern again.`
      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'repo_surface_map': {
      // Fast onboarding (fork): the auto-derived surface map for a repo with
      // no orientation doc (MERCURY.md, AGENTS.md or CLAUDE.md), injected once
      // on the first turn. Background context, not instructions; the closing
      // line keeps the model honest about its depth. The body is prompt text
      // the model receives (wire data) and keeps its wording.
      const content = `This repository has no CLAUDE.md, so here is an auto-derived surface map (a structure-only scan: languages, entry points, layout). Use it to orient instead of broad exploratory listing; verify anything load-bearing before relying on it, and prefer reading the repo's own docs where they exist.

${attachment.markdown}`
      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'context_capsule': {
      // The task-scoped working set — refs + reasons, never bodies.
      // Evidence-ranked; the digest needle is the dedup/resume cursor.
      const content = `${attachment.markdown}

These are evidence-ranked STARTING POINTS (exact task names > active work > import adjacency > current changes), not a complete file list — dereference to read, verify before relying, and explore beyond them when the task needs it.
capsule-digest:${attachment.digest}${attachment.delta ? `\nWorking-set delta vs the previous capsule: ${attachment.delta}` : ''}`
      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'ultra_effort': {
      return getUltraEffortInstructions(attachment)
    }
    case 'ultra_effort_exit': {
      const content = `Supercode is off — the standard opt-in rules apply again. Orchestrate (a Workflow / subagents / fleets) when a task genuinely benefits from it, and otherwise work solo.`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'supercode_keyword': {
      // Per-TURN keyword opt-in (the `supercode` keyword's
      // system-reminder). Confirms the explicit opt-in the Workflow tool prompt
      // tells the model to expect ("you'll see a system-reminder confirming it").
      const content = `The user included the keyword "supercode" in this prompt — an explicit opt-in to multi-agent orchestration for THIS request. Default to authoring and running a dynamic Workflow (the Workflow tool: agent()/parallel()/pipeline() scripts) for the substantive work here — decompose, fan out where independent, adversarially verify, then synthesize — and optimize for the most exhaustive, correct answer; token cost is not a constraint for this request. Solo only if the request is truly trivial. This opt-in is per-turn (standing mode is /effort supercode) and is not a license for destructive or outward-facing actions.`

      return wrapMessagesInSystemReminder([
        createUserMessage({ content, isMeta: true }),
      ])
    }
    case 'critical_system_reminder': {
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.content, isMeta: true }),
      ])
    }
    case 'taste_recall': {
      // Taste Loop recall (fork) — raw content, wrapped once here (mirror critical_system_reminder).
      // Model-only (NULL_RENDERING_TYPES); produced only on the main thread when promoted.
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.content, isMeta: true }),
      ])
    }
    case 'mcp_resource': {
      // Resource contents project like file attachments do: text composes,
      // binary stubs, empty says so.
      const content = attachment.content
      if (!content || !content.contents || content.contents.length === 0) {
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No content)</mcp-resource>`,
            isMeta: true,
          }),
        ])
      }

      // Project the resource contents into text blocks; only text items
      // compose (binary items leave a typed stub).
      const transformedBlocks: ContentBlockParam[] = []

      for (const item of content.contents) {
        if (item && typeof item === 'object') {
          if ('text' in item && typeof item.text === 'string') {
            transformedBlocks.push(
              {
                type: 'text',
                text: 'Full contents of resource:',
              },
              {
                type: 'text',
                text: item.text,
              },
              {
                type: 'text',
                text: 'These are the complete contents — re-read the resource only if you have reason to believe it changed.',
              },
            )
          } else if ('blob' in item) {
            const mimeType =
              'mimeType' in item
                ? String(item.mimeType)
                : 'application/octet-stream'
            transformedBlocks.push({
              type: 'text',
              text: `[Binary content: ${mimeType}]`,
            })
          }
        }
      }

      if (transformedBlocks.length > 0) {
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: transformedBlocks,
            isMeta: true,
          }),
        ])
      } else {
        logMCPDebug(
          attachment.server,
          `No displayable content found in MCP resource ${attachment.uri}.`,
        )
        // Nothing composed ⇒ say so explicitly rather than sending nothing.
        return wrapMessagesInSystemReminder([
          createUserMessage({
            content: `<mcp-resource server="${attachment.server}" uri="${attachment.uri}">(No displayable content)</mcp-resource>`,
            isMeta: true,
          }),
        ])
      }
    }
    case 'agent_mention': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The user's message names the agent "${attachment.agentType}" — invoke that agent for this work, passing it the context it needs.`,
          isMeta: true,
        }),
      ])
    }
    case 'task_status': {
      const displayStatus =
        attachment.status === 'killed' ? 'stopped' : attachment.status

      // Stopped: one line. The work was interrupted — its transcript delta
      // is not useful context.
      if (attachment.status === 'killed') {
        return [
          createUserMessage({
            content: wrapInSystemReminder(
              `Task "${attachment.description}" (${attachment.taskId}) was stopped by the user.`,
            ),
            isMeta: true,
          }),
        ]
      }

      // Running: this attachment only fires post-compaction, where the
      // original spawn message is absent — so the duplicate-spawn warning is
      // the whole point.
      if (attachment.status === 'running') {
        const parts = [
          `Background agent "${attachment.description}" (${attachment.taskId}) is still running.`,
        ]
        if (attachment.deltaSummary) {
          parts.push(`Progress: ${attachment.deltaSummary}`)
        }
        if (attachment.outputFilePath) {
          parts.push(
            `Do NOT spawn a duplicate — you will be notified when it completes. Partial output is readable at ${attachment.outputFilePath}, and ${SEND_MESSAGE_TOOL_NAME} reaches it directly.`,
          )
        } else {
          parts.push(
            `Do NOT spawn a duplicate — you will be notified when it completes. ${TASK_OUTPUT_TOOL_NAME} shows its progress, and ${SEND_MESSAGE_TOOL_NAME} reaches it directly.`,
          )
        }
        return [
          createUserMessage({
            content: wrapInSystemReminder(parts.join(' ')),
            isMeta: true,
          }),
        ]
      }

      // Completed/failed: the full labeled record.
      const messageParts: string[] = [
        `Task ${attachment.taskId}`,
        `(type: ${attachment.taskType})`,
        `(status: ${displayStatus})`,
        `(description: ${attachment.description})`,
      ]

      if (attachment.deltaSummary) {
        messageParts.push(`Delta: ${attachment.deltaSummary}`)
      }

      if (attachment.outputFilePath) {
        messageParts.push(
          `The result is in its output file: ${attachment.outputFilePath}`,
        )
      } else {
        messageParts.push(
          `Its output is available through the ${TASK_OUTPUT_TOOL_NAME} tool.`,
        )
      }

      return [
        createUserMessage({
          content: wrapInSystemReminder(messageParts.join(' ')),
          isMeta: true,
        }),
      ]
    }
    case 'async_hook_response': {
      // A late-settling hook can carry both a systemMessage and
      // additionalContext — each becomes its own meta message, each under
      // the seam bound (an async hook is the same external process the
      // sync lanes already bound; unbounded it wedges the session).
      const response = attachment.response
      const messages: UserMessage[] = []

      if (response.systemMessage) {
        messages.push(
          createUserMessage({
            content: boundHookContext(response.systemMessage, `${attachment.hookName}-async-system`).text,
            isMeta: true,
          }),
        )
      }

      if (
        response.hookSpecificOutput &&
        'additionalContext' in response.hookSpecificOutput &&
        response.hookSpecificOutput.additionalContext
      ) {
        messages.push(
          createUserMessage({
            content: boundHookContext(response.hookSpecificOutput.additionalContext, `${attachment.hookName}-async-context`).text,
            isMeta: true,
          }),
        )
      }

      return wrapMessagesInSystemReminder(messages)
    }
    // ('teammate_mailbox' and 'team_context' were handled ABOVE the switch —
    // their case labels would leak the literals into builds with the swarm
    // feature compiled out.)
    case 'token_usage':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Token usage: ${attachment.used}/${attachment.total}; ${attachment.remaining} remaining`,
          ),
          isMeta: true,
        }),
      ]
    case 'budget_usd':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `USD budget: $${attachment.used}/$${attachment.total}; $${attachment.remaining} remaining`,
          ),
          isMeta: true,
        }),
      ]
    case 'output_token_usage': {
      const turnText =
        attachment.budget !== null
          ? `${formatNumber(attachment.turn)} / ${formatNumber(attachment.budget)}`
          : formatNumber(attachment.turn)
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `Output tokens \u2014 turn: ${turnText} \u00b7 session: ${formatNumber(attachment.session)}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'hook_blocking_error':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook blocking error from command: "${attachment.blockingError.command}": ${boundHookContext(attachment.blockingError.blockingError, `${attachment.hookName}-block`).text}`,
          ),
          isMeta: true,
        }),
      ]
    case 'hook_success':
      if (
        attachment.hookEvent !== 'SessionStart' &&
        attachment.hookEvent !== 'UserPromptSubmit'
      ) {
        return []
      }
      if (attachment.content === '') {
        return []
      }
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook success: ${boundHookContext(attachment.content, attachment.hookName).text}`,
          ),
          isMeta: true,
        }),
      ]
    case 'hook_additional_context': {
      if (attachment.content.length === 0) {
        return []
      }
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook additional context: ${boundHookContext(attachment.content.join('\n'), `${attachment.hookName}-context`).text}`,
          ),
          isMeta: true,
        }),
      ]
    }
    case 'hook_stopped_continuation':
      return [
        createUserMessage({
          content: wrapInSystemReminder(
            `${attachment.hookName} hook stopped continuation: ${boundHookContext(attachment.message, `${attachment.hookName}-stop`).text}`,
          ),
          isMeta: true,
        }),
      ]
    case 'compaction_reminder': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            'Auto-compact is enabled. When the context window is nearly full, older messages will be automatically summarized so you can continue working seamlessly. There is no need to stop or rush \u2014 you have unlimited context through automatic compaction.',
          isMeta: true,
        }),
      ])
    }
    case 'context_efficiency': {
      // UI-only signal; contributes nothing to the model's context.
      return []
    }
    case 'date_change': {
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content: `The date has changed. Today's date is now ${attachment.newDate}. DO NOT mention this to the user explicitly because they are already aware.`,
          isMeta: true,
        }),
      ])
    }
    case 'user_context': {
      // The body already wears its system-reminder envelope (the one
      // builder both the persisted row and the per-request prepend use).
      return [createUserMessage({ content: attachment.body, isMeta: true })]
    }
    case 'deepthink_effort': {
      // ALIGNED: the standard sentence shape — the prose
      // IS the whole mechanism (adaptive thinking answers the nudge; effort
      // stays the operator's dial). Contract: effort.ts (DEEPTHINK block).
      return wrapMessagesInSystemReminder([
        createUserMessage({
          content:
            'The user included the keyword "deepthink", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants.',
          isMeta: true,
        }),
      ])
    }
    case 'deferred_tools_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        parts.push(
          `The following deferred tools are now available via ToolSearch:\n${attachment.addedLines.join('\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'agent_listing_delta': {
      const parts: string[] = []
      if (attachment.addedLines.length > 0) {
        const header = attachment.isInitial
          ? 'Available agent types for the Agent tool:'
          : 'New agent types are now available for the Agent tool:'
        parts.push(`${header}\n${attachment.addedLines.join('\n')}`)
      }
      if (attachment.removedTypes.length > 0) {
        parts.push(
          `The following agent types are no longer available:\n${attachment.removedTypes.map(t => `- ${t}`).join('\n')}`,
        )
      }
      if (attachment.isInitial && attachment.showConcurrencyNote) {
        parts.push(
          `Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses.`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'mcp_instructions_delta': {
      const parts: string[] = []
      if (attachment.addedBlocks.length > 0) {
        parts.push(
          `# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n${attachment.addedBlocks.join('\n\n')}`,
        )
      }
      if (attachment.removedNames.length > 0) {
        parts.push(
          `The following MCP servers have disconnected. Their instructions above no longer apply:\n${attachment.removedNames.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'harness_map_delta': {
      // A Mercury capability was toggled MID-SESSION (#182) — the memoized
      // harness-map prompt block can't reflect it, so the change announces
      // here (same pattern as mcp_instructions_delta).
      const parts: string[] = []
      if (attachment.added.length > 0) {
        parts.push(
          `Mercury harness update — the following surfaces just became AVAILABLE in this session:\n${attachment.added.join('\n')}`,
        )
      }
      if (attachment.removed.length > 0) {
        parts.push(
          `Mercury harness update — the following surfaces are no longer available (their harness-map lines no longer apply):\n${attachment.removed.join('\n')}`,
        )
      }
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: parts.join('\n\n'), isMeta: true }),
      ])
    }
    case 'lane_boundary': {
      // the side-lane boundary — re-asserted every turn in
      // a lane child (compaction can never lose it by construction).
      return wrapMessagesInSystemReminder([
        createUserMessage({ content: attachment.boundary, isMeta: true }),
      ])
    }
    case 'verify_plan_reminder': {
      // Retired surface, honestly empty. The verify-plan tool this reminder
      // pointed at is not in this build (its producer in
      // attachments/reminders.ts is folded to return [] as well); the old
      // body interpolated an EMPTY tool name and would have told the model
      // to call the "" tool — an instruction that can only ever mislead.
      return []
    }
    case 'already_read_file':
    case 'command_permissions':
    case 'edited_image_file':
    case 'hook_cancelled':
    case 'hook_error_during_execution':
    case 'hook_non_blocking_error':
    case 'hook_system_message':
    case 'structured_output':
    case 'hook_permission_decision':
      return []
  }

  // The legacy sink. A --resume'd session can carry attachment types this
  // build no longer produces; they project to nothing, silently and
  // deliberately. IMPORTANT: any type removed from the switch above JOINS
  // this list — otherwise resuming an old transcript logs an unknown-type
  // error for every occurrence.
  const LEGACY_ATTACHMENT_TYPES = [
    'autocheckpointing',
    'background_task_status',
    'todo',
    'task_progress',
    'ultramemory',
  ]
  if (LEGACY_ATTACHMENT_TYPES.includes((attachment as { type: string }).type)) {
    return []
  }

  logAntError(
    'normalizeAttachmentForAPI',
    new Error(
      `Unknown attachment type: ${(attachment as { type: string }).type}`,
    ),
  )
  return []
}

function createToolResultMessage<Output>(
  tool: Tool<AnyObject, Output>,
  toolUseResult: Output,
): UserMessage {
  try {
    const result = tool.mapToolResultToToolResultBlockParam(toolUseResult, '1')

    // Image-bearing results ride as raw blocks — stringifying an image
    // block would destroy it.
    if (
      Array.isArray(result.content) &&
      result.content.some(block => block.type === 'image')
    ) {
      return createUserMessage({
        content: result.content as ContentBlockParam[],
        isMeta: true,
      })
    }

    // String content rides RAW: jsonStringify's \n→\\n escaping costs about
    // a token per newline, so a 2000-line @-file would burn ~1000 tokens on
    // escapes alone. Arrays/objects still stringify — there the structure
    // is the content.
    const contentStr =
      typeof result.content === 'string'
        ? result.content
        : jsonStringify(result.content)
    return createUserMessage({
      content: `Result of calling the ${tool.name} tool:\n${contentStr}`,
      isMeta: true,
    })
  } catch {
    return createUserMessage({
      content: `Result of calling the ${tool.name} tool: Error`,
      isMeta: true,
    })
  }
}

function createToolUseMessage(
  toolName: string,
  input: { [key: string]: string | number },
): UserMessage {
  return createUserMessage({
    content: `Called the ${toolName} tool with the following input: ${jsonStringify(input)}`,
    isMeta: true,
  })
}
