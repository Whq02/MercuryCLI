export const AGENT_MESSAGE_STATUS = 'message'

export const MAIN_AGENT_MESSAGE_SUMMARY = 'The main agent sent a message'

const AGENT_MESSAGE_HEAD = new RegExp(
  `^<task-notification>\\n(?:<task-id>[^\\n]*<\\/task-id>\\n)?(?:<output-file>[^\\n]*<\\/output-file>\\n)?<status>${AGENT_MESSAGE_STATUS}<\\/status>\\n<summary>([\\s\\S]*?)<\\/summary>(?:\\n|$)`,
)

export function isAgentMessageNotice(text: string): boolean {
  return AGENT_MESSAGE_HEAD.test(text)
}

export function agentMessageLine(text: string): string {
  return AGENT_MESSAGE_HEAD.exec(text)?.[1] === MAIN_AGENT_MESSAGE_SUMMARY
    ? `${MAIN_AGENT_MESSAGE_SUMMARY}:`
    : 'A background crewmate sent a message:'
}
