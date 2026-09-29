export const RETIRED_TRANSCRIPT_ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  team_context: 'crew_context',
  teammate_shutdown_batch: 'crewmate_shutdown_batch',
}

export const RETIRED_TRANSCRIPT_ROW_KEYS: Readonly<Record<string, string>> = {
  teamName: 'crewName',
  isTeammate: 'isCrewmate',
  teamConfigPath: 'crewConfigPath',
  team_name: 'crew_name',
  teammate_id: 'crewmate_id',
}

export const RETIRED_TRANSCRIPT_VALUES: Readonly<Record<string, string>> = {
  teammate_spawned: 'crewmate_spawned',
  teammate_terminated: 'crewmate_terminated',
  in_process_teammate: 'in_process_crewmate',
  teammate: 'crewmate',
}

export const RETIRED_MESSAGE_TAG = 'teammate-message'
export const RETIRED_MESSAGE_ID_ATTRIBUTE = 'teammate_id'

export const RETIRED_TOOL_NAMES: Readonly<Record<string, string | null>> = {
  TeamBrief: 'LiveComms',
  TeamCreate: null,
  TeamDelete: null,
}

export const RETIRED_LIVE_COMMS_TOOL_NAME = 'TeamBrief'
export const RETIRED_CREWMATES_COMMAND_NAME = 'teammates'

export const RETIRED_AGENT_TOOL_FIELDS: Readonly<Record<string, string>> = {
  team_name: 'crew_name',
}

export const RETIRED_AGENT_SIDECAR_KEYS: Readonly<Record<string, string>> = {
  teammate: 'crewmate',
  teamName: 'crewName',
}

export const RETIRED_CREW_LEAD_NAME = 'team-lead'

export const RETIRED_CREW_MEMBER_ROLES: Readonly<Record<string, string>> = {
  teammate: 'crewmate',
}

export const RETIRED_JOURNAL_KINDS: Readonly<Record<string, string>> = {
  'team-create': 'crew-create',
  'team-delete': 'crew-delete',
}

export const RETIRED_SPAWN_LEDGER_KINDS: Readonly<Record<string, string>> = {
  teammate: 'crewmate',
  'teammate-refused': 'crewmate-refused',
}

export const RETIRED_CREWS_DIR_NAME = 'teams'

export const RETIRED_KEYBINDING_ACTIONS: Readonly<Record<string, string>> = {
  'app:toggleTeammatePreview': 'app:toggleCrewmatePreview',
}

export const RETIRED_CLI_FLAGS: Readonly<Record<string, string>> = {
  '--team-name': '--crew-name',
  '--agent-teams': '--agent-crews',
}

export const RETIRED_COMMAND_NAMES: Readonly<Record<string, string>> = {
  teammates: 'crewmates',
}

export const RETIRED_GLOBAL_CONFIG_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  expandedView: { teammates: 'crewmates' },
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function carriesRetiredKeys(record: Rec, keys: Readonly<Record<string, string>>): boolean {
  for (const key of Object.keys(keys)) if (key in record) return true
  return false
}

function renameKeys(record: Rec, keys: Readonly<Record<string, string>>): Rec {
  const out: Rec = {}
  for (const [key, value] of Object.entries(record)) {
    const current = keys[key]
    if (current === undefined) out[key] = value
    else if (!(current in record)) out[current] = value
  }
  return out
}

function readRetiredValue(value: unknown, table: Readonly<Record<string, string>>): unknown {
  return typeof value === 'string' && table[value] !== undefined ? table[value] : value
}

function readRetiredNoticeJson(text: unknown): unknown {
  if (typeof text !== 'string' || !text.startsWith('{')) return text
  let out = text
  for (const [retired, current] of Object.entries(RETIRED_TRANSCRIPT_VALUES)) {
    for (const quoted of [`"type":"${retired}"`, `"type": "${retired}"`]) {
      if (out.includes(quoted)) out = out.split(quoted).join(quoted.replace(retired, current))
    }
  }
  return out
}

export function readRetiredAttachment(attachment: unknown): unknown {
  if (!isRecord(attachment)) return attachment
  let out = attachment
  const type = RETIRED_TRANSCRIPT_ATTACHMENT_TYPES[String(out.type)]
  if (type !== undefined) out = { ...out, type }
  if (carriesRetiredKeys(out, RETIRED_TRANSCRIPT_ROW_KEYS)) out = renameKeys(out, RETIRED_TRANSCRIPT_ROW_KEYS)
  if (Array.isArray(out.messages)) {
    let changed = false
    const messages = out.messages.map(message => {
      if (!isRecord(message)) return message
      const text = readRetiredNoticeJson(message.text)
      if (text === message.text) return message
      changed = true
      return { ...message, text }
    })
    if (changed) out = { ...out, messages }
  }
  return out
}

export function readRetiredToolUseResult(result: unknown): unknown {
  if (!isRecord(result)) return result
  let out = result
  if (carriesRetiredKeys(out, RETIRED_TRANSCRIPT_ROW_KEYS)) out = renameKeys(out, RETIRED_TRANSCRIPT_ROW_KEYS)
  const status = readRetiredValue(out.status, RETIRED_TRANSCRIPT_VALUES)
  if (status !== out.status) out = { ...out, status }
  return out
}

function readRetiredToolUseInput(block: unknown): unknown {
  if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'Agent' || !isRecord(block.input)) return block
  if (!carriesRetiredKeys(block.input, RETIRED_AGENT_TOOL_FIELDS)) return block
  return { ...block, input: renameKeys(block.input, RETIRED_AGENT_TOOL_FIELDS) }
}

export function readRetiredTranscriptRow<T>(row: T, currentMessageTag = 'crewmate-message', currentMessageIdAttribute = 'crewmate_id'): T {
  if (!isRecord(row)) return row
  let out: Rec = row
  if (carriesRetiredKeys(out, RETIRED_TRANSCRIPT_ROW_KEYS)) out = renameKeys(out, RETIRED_TRANSCRIPT_ROW_KEYS)
  if (out.type === 'attachment' && isRecord(out.attachment)) {
    const attachment = readRetiredAttachment(out.attachment)
    if (attachment !== out.attachment) out = { ...out, attachment }
  }
  if ('toolUseResult' in out && isRecord(out.toolUseResult)) {
    const toolUseResult = readRetiredToolUseResult(out.toolUseResult)
    if (toolUseResult !== out.toolUseResult) out = { ...out, toolUseResult }
  }
  if (isRecord(out.message)) {
    const message = out.message
    if (typeof message.content === 'string' && message.content.includes(`<${RETIRED_MESSAGE_TAG}`)) {
      out = { ...out, message: { ...message, content: readRetiredMessageText(message.content, currentMessageTag, currentMessageIdAttribute) } }
    } else if (Array.isArray(message.content)) {
      const blocks: unknown[] = message.content
      const content = blocks.map(block => {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.includes(`<${RETIRED_MESSAGE_TAG}`)) {
          return { ...block, text: readRetiredMessageText(block.text, currentMessageTag, currentMessageIdAttribute) }
        }
        return readRetiredToolUseInput(block)
      })
      if (content.some((block, i) => block !== blocks[i])) out = { ...out, message: { ...message, content } }
    }
  }
  return out as T
}

export function readRetiredAgentToolInput(input: unknown): unknown {
  if (!isRecord(input) || !carriesRetiredKeys(input, RETIRED_AGENT_TOOL_FIELDS)) return input
  return renameKeys(input, RETIRED_AGENT_TOOL_FIELDS)
}

export function readRetiredAgentSidecar<T extends Rec>(parsed: T): T {
  let out: Rec = parsed
  if (carriesRetiredKeys(out, RETIRED_AGENT_SIDECAR_KEYS)) out = renameKeys(out, RETIRED_AGENT_SIDECAR_KEYS)
  const record = out.crewmate
  if (isRecord(record) && carriesRetiredKeys(record, RETIRED_AGENT_SIDECAR_KEYS)) out = { ...out, crewmate: renameKeys(record, RETIRED_AGENT_SIDECAR_KEYS) }
  return out as T
}

export function isRetiredCrewLeadName(name: string): boolean {
  return name.toLowerCase() === RETIRED_CREW_LEAD_NAME
}

export function readRetiredCrewMemberRole(role: unknown): unknown {
  return readRetiredValue(role, RETIRED_CREW_MEMBER_ROLES)
}

export function readRetiredJournalKind(kind: string): string {
  return RETIRED_JOURNAL_KINDS[kind] ?? kind
}

export function readRetiredSpawnLedgerKind(kind: string): string {
  return RETIRED_SPAWN_LEDGER_KINDS[kind] ?? kind
}

export function readRetiredKeybindingAction(action: string): string {
  return RETIRED_KEYBINDING_ACTIONS[action] ?? action
}

export function readRetiredCliFlags(argv: readonly string[]): string[] {
  return argv.map(arg => {
    const eq = arg.indexOf('=')
    const head = eq === -1 ? arg : arg.slice(0, eq)
    const current = RETIRED_CLI_FLAGS[head]
    return current === undefined ? arg : eq === -1 ? current : current + arg.slice(eq)
  })
}

export function readRetiredMessageText(text: string, currentTag: string, currentIdAttribute: string): string {
  if (!text.includes(`<${RETIRED_MESSAGE_TAG}`)) return text
  return text
    .split(`<${RETIRED_MESSAGE_TAG}`).join(`<${currentTag}`)
    .split(`</${RETIRED_MESSAGE_TAG}>`).join(`</${currentTag}>`)
    .split(` ${RETIRED_MESSAGE_ID_ATTRIBUTE}="`).join(` ${currentIdAttribute}="`)
}

export function readRetiredJournalKey(key: string): string {
  for (const [retired, current] of Object.entries(RETIRED_JOURNAL_KINDS)) {
    if (key.startsWith(`${retired}:`)) return current + key.slice(retired.length)
  }
  return key
}

export function isRetiredToolName(name: string): boolean {
  return name in RETIRED_TOOL_NAMES
}

type CrewFileLike = { leadAgentId?: unknown; members?: unknown }

function readRetiredCrewIdentity(value: unknown, currentLeadName: string): unknown {
  if (typeof value !== 'string') return value
  if (value === RETIRED_CREW_LEAD_NAME) return currentLeadName
  if (value.startsWith(`${RETIRED_CREW_LEAD_NAME}@`)) return currentLeadName + value.slice(RETIRED_CREW_LEAD_NAME.length)
  return value
}

export function readRetiredCrewFile<T extends CrewFileLike>(file: T, currentLeadName: string): T {
  let out: CrewFileLike = file
  const leadAgentId = readRetiredCrewIdentity(out.leadAgentId, currentLeadName)
  if (leadAgentId !== out.leadAgentId) out = { ...out, leadAgentId }
  if (Array.isArray(out.members)) {
    let changed = false
    const members = out.members.map(member => {
      if (!isRecord(member)) return member
      const name = readRetiredCrewIdentity(member.name, currentLeadName)
      const agentId = readRetiredCrewIdentity(member.agentId, currentLeadName)
      const role = readRetiredCrewMemberRole(member.role)
      if (name === member.name && agentId === member.agentId && role === member.role) return member
      changed = true
      return { ...member, name, agentId, ...(role === undefined ? {} : { role }) }
    })
    if (changed) out = { ...out, members }
  }
  return out as T
}

export function readRetiredGlobalConfigValue(key: string, value: unknown): unknown {
  const table = RETIRED_GLOBAL_CONFIG_VALUES[key]
  return table === undefined ? value : readRetiredValue(value, table)
}

export function isRetiredTranscriptValue(value: unknown, current: string): boolean {
  return typeof value === 'string' && (value === current || RETIRED_TRANSCRIPT_VALUES[value] === current)
}

export function currentToolName(name: string): string | null {
  const current = RETIRED_TOOL_NAMES[name]
  return current === undefined ? name : current
}
