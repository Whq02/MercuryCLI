
type StructuralTeamContext = {
  teamName: string
  teammates: Record<string, { name: string }>
}

type MailboxWriter = (
  recipient: string,
  message: {
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  },
  teamName?: string,
) => Promise<boolean | void>

export type DirectMessageResult =
  | { success: true; recipientName: string }
  | { success: false; error: 'no_team_context' }
  | { success: false; error: 'unknown_recipient'; recipientName: string }

export function parseDirectMemberMessage(
  input: string,
): { recipientName: string; message: string } | null {
  const match = /^@([\w-]+)\s([\s\S]+)$/.exec(input)
  if (!match) return null
  const recipientName = match[1] as string
  const message = (match[2] as string).trim()
  if (recipientName === '' || message === '') return null
  return { recipientName, message }
}

export async function sendDirectMemberMessage(
  recipientName: string,
  message: string,
  teamContext: StructuralTeamContext | null | undefined,
  writeToMailbox?: MailboxWriter,
): Promise<DirectMessageResult> {
  if (!teamContext || !writeToMailbox) {
    return { success: false, error: 'no_team_context' }
  }
  const recipient = Object.values(teamContext.teammates).find(
    teammate => teammate.name === recipientName,
  )
  if (!recipient) {
    return { success: false, error: 'unknown_recipient', recipientName }
  }
  await writeToMailbox(
    recipientName,
    { from: 'user', text: message, timestamp: new Date().toISOString() },
    teamContext.teamName,
  )
  return { success: true, recipientName }
}
