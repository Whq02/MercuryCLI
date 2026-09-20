export const AGENT_MESSAGE_STATUS = 'message'

export const MAIN_AGENT_MESSAGE_SUMMARY = 'The main agent sent a message'

export const AGENT_MESSAGE_STATUS_ELEMENT = `<status>${AGENT_MESSAGE_STATUS}</status>`

export function isAgentMessageNotice(text: string): boolean {
  return text.includes(AGENT_MESSAGE_STATUS_ELEMENT)
}

export function agentMessageLine(text: string): string {
  return text.includes(`<summary>${MAIN_AGENT_MESSAGE_SUMMARY}</summary>`)
    ? `${MAIN_AGENT_MESSAGE_SUMMARY}:`
    : 'A background agent sent a message:'
}
