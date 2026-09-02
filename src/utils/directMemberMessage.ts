/**
 * Parse and deliver a direct `@name message` to a team member's mailbox
 * without a model round-trip.
 *
 * The mailbox writer's shape is deliberately structural so the real writer
 * supplied through application state is assignable without importing it.
 */

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

/**
 * Parse `@name message`: an at-sign, a word-characters-and-hyphens name, at
 * least one whitespace character, then a non-empty remainder (across
 * newlines). Null for non-matches and whitespace-only messages.
 */
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

/**
 * Write a mailbox entry from the literal sender `user` to the recipient,
 * scoped to the context's team. The writer's boolean result is awaited but
 * not inspected. Callers branch on the error codes.
 */
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
