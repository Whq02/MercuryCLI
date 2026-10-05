
type StructuralCrewContext = {
  crewName: string
  crewmates: Record<string, { name: string }>
}

type LiveMessageSender = (
  crew: string | undefined,
  message: {
    to: string
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  },
) => Promise<boolean | void>

type DirectMessageResult =
  | { success: true; recipientName: string }
  | { success: false; error: 'no_crew_context' }
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
  crewContext: StructuralCrewContext | null | undefined,
  send?: LiveMessageSender,
): Promise<DirectMessageResult> {
  if (!crewContext || !send) {
    return { success: false, error: 'no_crew_context' }
  }
  const recipient = Object.values(crewContext.crewmates).find(
    crewmate => crewmate.name === recipientName,
  )
  if (!recipient) {
    return { success: false, error: 'unknown_recipient', recipientName }
  }
  await send(crewContext.crewName, { to: recipientName, from: 'user', text: message, timestamp: new Date().toISOString() })
  return { success: true, recipientName }
}
