import type { ContentBlockParam, TextBlockParam } from '../../types/wire.js'
import type { AnyObject, Tool } from '../../Tool.js'
import type { MessageOrigin, UserMessage } from '../../types/message.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { FileReadTool, type Output as FileReadToolOutput } from '../../tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME, MAX_LINES_TO_READ } from '../../tools/FileReadTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/SendMessageTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../../tools/ResumeAgentTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../../tools/TaskCreateTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../../tools/TaskStopTool/prompt.js'
import { TASK_UPDATE_TOOL_NAME } from '../../tools/TaskUpdateTool/constants.js'
import { DiagnosticTrackingService } from '../../services/diagnosticTracking.js'
import { operatorMessagesBlockText } from '../../services/compact/operatorMessages.js'
import { type Attachment } from '../attachments.js'
import { DEFERRED_TOOLS_ANNOUNCEMENT_HEAD } from '../attachments/deltas.js'
import { boundHookContext } from '../hooks/contextBound.js'
import { quote } from '../bash/shellQuote.js'
import { formatFileSize, formatNumber } from '../format.js'
import { jsonStringify } from '../slowOperations.js'
import { isTaskToolsEnabled } from '../tasks.js'
import { createUserMessage } from './factories.js'
import { isAdvisorOrigin } from './noticeRows.js'
import { wrapCommandText, wrapInSystemReminder, wrapMessagesInSystemReminder } from './text.js'

type Kind = Attachment['type']
type Of<K extends Kind> = Extract<Attachment, { type: K }>
type Renderers = { [K in Kind]?: (value: Of<K>) => UserMessage[] }
type Body = string | ContentBlockParam[]

const meta = (content: Body): UserMessage => createUserMessage({ isMeta: true, content })
const reminders = (...bodies: Body[]): UserMessage[] => wrapMessagesInSystemReminder(bodies.map(meta))
const notice = (body: string): UserMessage[] => [meta(wrapInSystemReminder(body))]
const text = (body: string): TextBlockParam => ({ type: 'text', text: body })

function toolResult<Output>(tool: Tool<AnyObject, Output>, output: Output): UserMessage {
  try {
    const payload = tool.mapToolResultToToolResultBlockParam(output, '1').content
    const carriesImage = Array.isArray(payload) && payload.some(block => block.type === 'image')
    return meta(carriesImage ? payload as ContentBlockParam[] : `${tool.name} returned:\n${typeof payload === 'string' ? payload : jsonStringify(payload)}`)
  } catch {
    return meta(`${tool.name} returned an error`)
  }
}

function toolRead<Output>(tool: Tool<AnyObject, Output>, input: Record<string, string | number>, output: Output): UserMessage[] {
  const invoked = meta(`Mercury ran ${tool.name} with ${jsonStringify(input)}`)
  return [invoked, toolResult(tool, output)]
}

function fileRows(file: Of<'file'>): UserMessage[] {
  const payload = file.content as FileReadToolOutput
  if (!['text', 'image', 'notebook', 'pdf'].includes(payload.type)) return []
  const rows = toolRead(FileReadTool, { file_path: file.filename }, payload)
  if (payload.type === 'text' && file.truncated) {
    rows.push(meta(`${file.filename} was too large — only its first ${MAX_LINES_TO_READ} lines are shown above. Read further with ${FileReadTool.name} when you need more; do not mention the truncation to the user.`))
  }
  return wrapMessagesInSystemReminder(rows)
}

function resourceBlocks(item: unknown): ContentBlockParam[] {
  if (item === null || typeof item !== 'object') return []
  if ('text' in item && typeof item.text === 'string') {
    return [
      text('Full contents of resource:'), text(item.text),
      text('These are the complete contents — re-read the resource only if you have reason to believe it changed.'),
    ]
  }
  return 'blob' in item ? [text(`[Binary content: ${'mimeType' in item ? String(item.mimeType) : 'application/octet-stream'}]`)] : []
}

function resourceRows(resource: Of<'mcp_resource'>): UserMessage[] {
  const blocks = (resource.content?.contents ?? []).flatMap(resourceBlocks)
  return reminders(blocks.length ? blocks : `<mcp-resource server="${resource.server}" uri="${resource.uri}">the server returned nothing readable for this resource</mcp-resource>`)
}

function queuedRows(queued: Of<'queued_command'>): UserMessage[] {
  const origin: MessageOrigin | undefined = queued.origin ?? (queued.commandMode === 'task-notification' ? { kind: 'task-notification' } : undefined)
  const prompt = queued.prompt
  const blocks = Array.isArray(prompt) ? prompt : undefined
  const raw = blocks ? blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : String(prompt)
  const wrapped = wrapCommandText(raw, origin)
  const content: Body = blocks ? [text(wrapped), ...blocks.filter(block => block.type === 'image')] : wrapped
  const hide = (origin !== undefined && !isAdvisorOrigin(origin)) || queued.isMeta
  return wrapMessagesInSystemReminder([createUserMessage({ content, origin, uuid: queued.source_uuid, queued: true, ...(hide ? { isMeta: true } : {}) })])
}

const workingSetGuidance = 'These are evidence-ranked STARTING POINTS (exact task names > active work > import adjacency > current changes), not a complete file list — dereference to read, verify before relying, and explore beyond them when the task needs it.'
const protectReminder = (body: string): string => body.replace(/<(\/?)system-reminder/g, '<\u200b$1system-reminder')

function capsuleRows(capsule: Of<'context_capsule'>): UserMessage[] {
  if (!capsule.sections) {
    return reminders(`${capsule.markdown}\n\n${workingSetGuidance}\ncapsule-digest:${capsule.digest}${capsule.delta ? `\nWorking-set delta vs the previous capsule: ${capsule.delta}` : ''}`)
  }
  const sequence: Array<string | ContentBlockParam> = ['<system-reminder>\n', protectReminder(capsule.markdown || '# Working set')]
  if (capsule.markdown) sequence.push('\n\n' + workingSetGuidance)
  if (capsule.workingSet?.length) sequence.push('\n\n' + capsule.workingSet.map(item => protectReminder(`- ${item.ref} — ${item.reason}`)).join('\n'))
  for (const section of capsule.sections) {
    sequence.push('\n\n## ' + protectReminder(section.name))
    sequence.push(...section.content.map(block => block.type === 'text' ? '\n\n' + protectReminder(block.text) : block))
  }
  sequence.push('\n\ncapsule-digest:' + protectReminder(capsule.digest))
  if (capsule.delta) sequence.push('\nWorking-set delta vs the previous capsule: ' + protectReminder(capsule.delta))
  sequence.push('\n</system-reminder>')
  const content: ContentBlockParam[] = []
  let pending = ''
  for (const part of sequence) {
    if (typeof part === 'string') pending += part
    else {
      if (pending) content.push(text(pending))
      pending = ''
      content.push(part)
    }
  }
  if (pending) content.push(text(pending))
  return [meta(content)]
}

function skillListing(listing: Of<'skill_listing'>): UserMessage[] {
  const parts = listing.content ? [`The skills this session offers, run by name through the Skill tool:\n\n${listing.content}`] : []
  const limit = listing.truncation
  const losses = [
    limit && limit.nameOnly > 0 ? `${limit.nameOnly} of the entries above list name-only (the catalogue budget was reached); each skill's full description is available on invocation` : '',
    limit && limit.withheld > 0 ? `${limit.withheld} further skill name(s) were withheld entirely` : '',
  ].filter(Boolean)
  if (losses.length) parts.push('Note: ' + losses.join('; ') + '.')
  if (listing.removedNames?.length) parts.push(`The following skills are no longer available (dialled off or removed). Do not invoke them — the Skill tool will refuse:\n${listing.removedNames.join('\n')}`)
  return parts.length ? reminders(parts.join('\n\n')) : []
}

function contractRows(contract: Of<'contract_reminder'>): UserMessage[] {
  const history = contract.amendments > 0 ? ` (${contract.amendments} superseded text${contract.amendments === 1 ? '' : 's'} in its history)` : ''
  const acknowledgment = contract.ackOwed ? '\n\nIt awaits your acknowledgment: restate it in your own words through the `contract` tool ({ action: "acknowledge", restatement }) — the restatement is what makes it stick.' : ''
  return reminders(`This session runs under a contract — its work agreement, status ${contract.status}${history}. It is advisory: it never blocks anything; hold yourself to it, check in through the \`contract\` tool when unsure, and propose an amendment there when a clause does not survive contact with the code.${acknowledgment}\n\nThe agreement:\n\n${contract.text}`)
}

function taskRows(tasks: Of<'task_reminder'>): UserMessage[] {
  if (!isTaskToolsEnabled()) return []
  const items = tasks.content.map(task => `#${task.id}. [${task.status}] ${task.subject}`).join('\n')
  const guidance = `The task list has not moved in a while: if the current work benefits from tracked progress, ${TASK_CREATE_TOOL_NAME} adds items and ${TASK_UPDATE_TOOL_NAME} moves their status (in_progress on start, completed on finish); a stale list is cleaned up.\n`
  return reminders(guidance + (items ? '\n\nThe current tasks:\n\n' + items : ''))
}

function rosterLine(row: Of<'agent_roster'>['rows'][number]): string {
  const address = row.address === null
    ? `reach it: ${TASK_STOP_TOOL_NAME} by its id`
    : row.status === 'running' ? `reach it: ${SEND_MESSAGE_TOOL_NAME} to "${row.address}"` : `resume it: ${RESUME_AGENT_TOOL_NAME} to "${row.address}"`
  const fields = [
    `${row.taskType} "${row.name}" [${row.taskId}]: ${row.status}`,
    row.wait,
    row.phase ? `phase: ${row.phase}` : '',
    row.agents?.length ? `crewmates: ${row.agents.map(agent => `${agent.label} — ${agent.state}`).join(', ')}` : '',
    row.description && row.description !== row.name ? `asked: ${row.description}` : '',
    row.error ? `error: ${row.error}` : '',
    row.owed ? `owed: ${row.owed}` : '',
    address,
    row.outputFilePath ? `output: ${row.outputFilePath}` : '',
  ]
  return '- ' + fields.filter(Boolean).join(' · ')
}

function rosterRows(roster: Of<'agent_roster'>): UserMessage[] {
  if (!roster.rows.length) return []
  const totals = new Map<string, number>()
  const lines = roster.rows.map(row => {
    totals.set(row.status, 1 + (totals.get(row.status) ?? 0))
    return rosterLine(row)
  })
  return notice([
    'Agents in flight at the context turnover — every agent this session is running or owes a result from, one line each (kind "name" [id]: status · what it was asked · what is owed · how to reach it · output file):',
    `${roster.rows.length} agent${roster.rows.length === 1 ? '' : 's'}: ${Array.from(totals, ([state, count]) => `${count} ${state}`).join(' · ')}`,
    ...lines,
    `A running agent is never re-spawned — its completion reaches you as a task notification on its own. A result that is owed is collected from that notification or from the output file, never re-derived. ${SEND_MESSAGE_TOOL_NAME} reaches a running crewmate and ${RESUME_AGENT_TOOL_NAME} gives any one a new turn, by the id or name shown; a task's output is read from the output file shown with ${FILE_READ_TOOL_NAME}; ${TASK_STOP_TOOL_NAME} stops one.`,
  ].join('\n'))
}

function changedLists(groups: Array<[string[], string, string]>): UserMessage[] {
  return reminders(groups.filter(([items]) => items.length > 0).map(([items, heading, separator]) => heading + items.join(separator)).join('\n\n'))
}

function hookRows(hook: Of<'hook'>): UserMessage[] {
  const outcome = hook.outcome === 'context' ? 'context' : hook.outcome === 'block' && hook.event === 'tool.after' ? 'block' : null
  if (outcome === null) return []
  const lead = outcome === 'context' ? `hook ${hook.name} (${hook.event}): ` : `hook ${hook.name} objected to this ${hook.event} call: `
  return notice(lead + boundHookContext(hook.words, `${hook.name}-${outcome}`).text)
}

const renderers: Renderers = {
  directory: item => wrapMessagesInSystemReminder(toolRead(BashTool, { command: `ls ${quote([item.path])}`, description: `Lists files in ${item.path}` }, { stdout: item.content, stderr: '', interrupted: false })),
  file: fileRows,
  mcp_resource: resourceRows,
  edited_text_file: item => reminders(`${item.filename} changed outside this conversation — the user or a linter edited it. The change is intentional: work with it, and never revert it unless the user asks. Do not mention it to the user; they already know. The relevant changes (with line numbers):\n${item.snippet}`),
  compact_file_reference: item => reminders(`${item.filename} was read before the conversation was summarized, and its contents are too large to carry across. Re-read it with ${FileReadTool.name} when you need it.`),
  pdf_reference: item => reminders(`PDF: ${item.filename} (${item.pageCount} pages, ${formatFileSize(item.fileSize)}) — too large to read in one pass. Read it through ${FILE_READ_TOOL_NAME} with the pages parameter, in ranges (e.g. pages: "1-5"); a call WITHOUT pages will fail on this file. Start with the first few pages to learn the structure, then pull more as needed — at most 20 pages per request.`),
  diagnostics: item => item.files.length ? reminders(`<new-diagnostics>New diagnostics from the language server:\n\n${DiagnosticTrackingService.formatDiagnosticsSummary(item.files)}</new-diagnostics>`) : [],
  queued_command: queuedRows,
  context_capsule: capsuleRows,
  contract_reminder: contractRows,
  task_reminder: taskRows,
  agent_roster: rosterRows,
  agent_mention: item => reminders(`The user's message names the agent "${item.agentType}" — invoke that agent for this work, passing it the context it needs.`),
  invoked_skills: item => item.skills.length ? reminders('These skills were invoked earlier in the session and still bind — keep following them:\n\n' + item.skills.map(skill => `### ${skill.name} (${skill.path})\n\n${skill.content}`).join('\n\n---\n\n')) : [],
  skill_listing: skillListing,
  nested_memory: item => reminders(`Instruction file ${item.content.path} (it governs its folder):\n\n${item.content.content}`),
  mode_pack: item => item.mode === 'apollo' ? reminders(item.text) : [],
  mode_pack_exit: item => item.mode === 'apollo' ? reminders(`## Exited Apollo mode\n\nApollo mode is off: its instructions above no longer apply, and the session's standing instructions govern again.${item.reason !== undefined ? ` What ended it: ${item.reason}.` : ''}`) : [],
  hook: hookRows,
  critical_system_reminder: item => reminders(item.content),
  user_context: item => [meta(item.body)],
  compact_operator_messages: item => item.messages.length ? [meta(operatorMessagesBlockText(item))] : [],
  loop_stopped: item => notice(item.message),
  date_change: item => reminders(`The local date is now ${item.newDate}; the session context above still names the earlier one.`),
  budget_usd: item => notice(`Budget — spent $${item.used} of $${item.total} · $${item.remaining} left`),
  output_token_usage: item => {
    const turn = formatNumber(item.turn)
    const allowance = item.budget === null ? '' : ` of ${formatNumber(item.budget)}`
    return notice(`Output so far — this turn: ${turn}${allowance} tokens; this session: ${formatNumber(item.session)} tokens`)
  },
  usage_limit_notice: item => notice((require('../../services/providers/limitWarning.js') as typeof import('../../services/providers/limitWarning.js')).usageWarningNoticeText(item.text, item.pct)),
  held_tools: item => reminders(item.body),
  tool_schema_delta: item => reminders(item.body),
  deferred_tools_delta: item => item.body !== undefined ? reminders(item.body) : changedLists([
    [item.addedLines, DEFERRED_TOOLS_ANNOUNCEMENT_HEAD + '\n', '\n'],
    [item.removedNames, 'The following deferred tools are no longer available in this session (their server disconnected or the operator turned them off). Do not search for them — ToolSearch will return no match:\n', '\n'],
  ]),
  mcp_instructions_delta: item => changedLists([
    [item.addedBlocks, '# MCP server instructions\n\nEach server below says how its tools and resources are used:\n\n', '\n\n'],
    [item.removedNames, 'MCP servers gone from this session; their instructions above no longer hold:\n', '\n'],
  ]),
  mcp_servers_failed: item => reminders(item.body),
  harness_map_delta: item => changedLists([
    [item.added, 'Mercury harness update — the following surfaces just became AVAILABLE in this session:\n', '\n'],
    [item.removed, 'Mercury harness update — the following surfaces are no longer available (their harness-map lines no longer apply):\n', '\n'],
  ]),
}

export function normalizeAttachmentForAPI(attachment: Attachment): UserMessage[] {
  if (attachment.capsuleReceipt || !Object.hasOwn(renderers, attachment.type)) return []
  const render = renderers[attachment.type] as (item: Attachment) => UserMessage[]
  return render(attachment)
}
