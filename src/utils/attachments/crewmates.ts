
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getViewedCrewmateTask } from '../../state/selectors.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { logForDebugging } from '../debug.js'
import { getMercuryHome } from '../envUtils.js'
import { removeCrewmateFromCrewFile } from '../swarm/crewHelpers.js'
import { unassignCrewmateTasks } from '../tasks.js'
import {
  getAgentId,
  getAgentName,
  getCrewName,
  isCrewLead,
} from '../crewmate.js'
import { isInProcessCrewmate } from '../crewmateContext.js'
import {
  isIdleNotification,
  isShutdownApproved,
  isStructuredProtocolMessage,
  markMessagesAsReadByPredicate,
  readUnreadMessages,
  resolveShutdownApprovedVictim,
} from '../crewmateMailbox.js'
import type { Attachment } from './types.js'

export async function getCrewmateMailboxAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isAgentSwarmsEnabled()) {
    return []
  }
  {
    return []
  }

  const appState = toolUseContext.getAppState()

  const envAgentName = getAgentName()
  const teamName = getCrewName(appState.crewContext)
  const crewLeadStatus = isCrewLead(appState.crewContext)
  const viewedCrewmate = getViewedCrewmateTask(appState)

  let agentName = viewedCrewmate?.identity.agentName ?? envAgentName
  if (!agentName && crewLeadStatus && appState.crewContext) {
    const leadAgentId = appState.crewContext!.leadAgentId
    agentName = appState.crewContext!.crewmates[leadAgentId]?.name || 'team-lead'
  }

  logForDebugging(
    `[SwarmMailbox] getCrewmateMailboxAttachments called: envAgentName=${envAgentName}, isCrewLead=${crewLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`,
  )

  if (!agentName) {
    logForDebugging(
      `[SwarmMailbox] Not checking inbox - not in a swarm or team lead`,
    )
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Checking inbox for agent="${agentName}" team="${teamName || 'default'}"`,
  )

  const allUnreadMessages = await readUnreadMessages(agentName!, teamName)
  const unreadMessages = allUnreadMessages.filter(
    m => !isStructuredProtocolMessage(m.text),
  )
  logForDebugging(
    `[MailboxBridge] Found ${allUnreadMessages.length} unread message(s) for "${agentName}" (${allUnreadMessages.length - unreadMessages.length} structured protocol messages filtered out)`,
  )

  const pendingInboxMessages =
    viewedCrewmate || isInProcessCrewmate()
      ? []
      : appState.inbox.messages.filter(m => m.status === 'pending')
  logForDebugging(
    `[SwarmMailbox] Found ${pendingInboxMessages.length} pending message(s) in AppState.inbox`,
  )

  const seen = new Set<string>()
  let allMessages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }> = []

  for (const m of [...unreadMessages, ...pendingInboxMessages]) {
    const key = `${m.from}|${m.timestamp}|${m.text.slice(0, 100)}`
    if (!seen.has(key)) {
      seen.add(key)
      allMessages.push({
        from: m.from,
        text: m.text,
        timestamp: m.timestamp,
        color: m.color,
        summary: m.summary,
      })
    }
  }

  const idleAgentByIndex = new Map<number, string>()
  const latestIdleByAgent = new Map<string, number>()
  for (let i = 0; i < allMessages.length; i++) {
    const idle = isIdleNotification(allMessages[i]!.text)
    if (idle) {
      idleAgentByIndex.set(i, idle!.from)
      latestIdleByAgent.set(idle!.from, i)
    }
  }
  if (idleAgentByIndex.size > latestIdleByAgent.size) {
    const beforeCount = allMessages.length
    allMessages = allMessages.filter((_m, i) => {
      const agent = idleAgentByIndex.get(i)
      if (agent === undefined) return true
      return latestIdleByAgent.get(agent) === i
    })
    logForDebugging(
      `[SwarmMailbox] Collapsed ${beforeCount - allMessages.length} duplicate idle notification(s)`,
    )
  }

  if (allMessages.length === 0) {
    logForDebugging(`[SwarmMailbox] No messages to deliver, returning empty`)
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Returning ${allMessages.length} message(s) as attachment for "${agentName}" (${unreadMessages.length} from file, ${pendingInboxMessages.length} from AppState, after dedup)`,
  )

  const attachment: Attachment[] = [
    {
      type: 'teammate_mailbox',
      messages: allMessages,
    },
  ]

  if (unreadMessages.length > 0) {
    const deliveredKeys = new Set(
      unreadMessages.map(m => `${m.from} ${m.timestamp} ${m.text}`),
    )
    await markMessagesAsReadByPredicate(
      agentName!,
      m =>
        !isStructuredProtocolMessage(m.text) &&
        deliveredKeys.has(`${m.from} ${m.timestamp} ${m.text}`),
      teamName,
    )
    logForDebugging(
      `[MailboxBridge] marked ${unreadMessages.length} non-structured message(s) as read for agent="${agentName}" team="${teamName || 'default'}"`,
    )
  }

  if (crewLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        const crewmateToRemove = resolveShutdownApprovedVictim(m.from, shutdownApproval!)
        if (!crewmateToRemove) {
          logForDebugging(
            `[SwarmMailbox] Ignoring shutdown_approved: in-body from "${shutdownApproval!.from}" != verified sender "${m.from}"`,
          )
          continue
        }
        logForDebugging(
          `[SwarmMailbox] Processing shutdown_approved from ${crewmateToRemove}`,
        )

        const crewmateId = appState.crewContext?.crewmates
          ? Object.entries(appState.crewContext!.crewmates).find(
              ([, t]) => t.name === crewmateToRemove,
            )?.[0]
          : undefined

        if (crewmateId) {
          removeCrewmateFromCrewFile(teamName!, {
            agentId: crewmateId,
            name: crewmateToRemove!,
          })
          logForDebugging(
            `[SwarmMailbox] Removed ${crewmateToRemove} from team file`,
          )

          await unassignCrewmateTasks(
            teamName!,
            crewmateId!,
            crewmateToRemove!,
            'shutdown',
          )

          toolUseContext.setAppState(prev => {
            if (!prev.crewContext?.crewmates) return prev
            if (!(crewmateId! in prev.crewContext.crewmates)) return prev
            const { [crewmateId!]: _, ...remainingCrewmates } =
              prev.crewContext.crewmates
            return {
              ...prev,
              crewContext: {
                ...prev.crewContext,
                crewmates: remainingCrewmates,
              },
            }
          })
        }
      }
    }
  }

  if (pendingInboxMessages.length > 0) {
    const pendingIds = new Set(pendingInboxMessages.map(m => m.id))
    toolUseContext.setAppState(prev => ({
      ...prev,
      inbox: {
        messages: prev.inbox.messages.map(m =>
          pendingIds.has(m.id) ? { ...m, status: 'processed' as const } : m,
        ),
      },
    }))
  }

  return attachment
}

export function getCrewContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getCrewName()
  const agentId = getAgentId()
  const agentName = getAgentName()

  if (!teamName || !agentId) {
    return []
  }

  const hasAssistantMessage = messages.some(m => m.type === 'assistant')
  if (hasAssistantMessage) {
    return []
  }

  const configDir = getMercuryHome()
  const teamConfigPath = `${configDir}/teams/${teamName}/config.json`
  const taskListPath = `${configDir}/tasks/${teamName}/`

  return [
    {
      type: 'team_context',
      agentId,
      agentName: agentName || agentId,
      teamName,
      teamConfigPath,
      taskListPath,
    },
  ]
}
