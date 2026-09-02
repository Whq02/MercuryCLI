
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { getViewedTeammateTask } from '../../state/selectors.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { logForDebugging } from '../debug.js'
import { getMercuryHome } from '../envUtils.js'
import { removeTeammateFromTeamFile } from '../swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../tasks.js'
import {
  getAgentId,
  getAgentName,
  getTeamName,
  isTeamLead,
} from '../teammate.js'
import { isInProcessTeammate } from '../teammateContext.js'
import {
  isIdleNotification,
  isShutdownApproved,
  isStructuredProtocolMessage,
  markMessagesAsReadByPredicate,
  readUnreadMessages,
  resolveShutdownApprovedVictim,
} from '../teammateMailbox.js'
import type { Attachment } from './types.js'

export async function getTeammateMailboxAttachments(
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
  const teamName = getTeamName(appState.teamContext)
  const teamLeadStatus = isTeamLead(appState.teamContext)
  const viewedTeammate = getViewedTeammateTask(appState)

  let agentName = viewedTeammate?.identity.agentName ?? envAgentName
  if (!agentName && teamLeadStatus && appState.teamContext) {
    const leadAgentId = appState.teamContext!.leadAgentId
    agentName = appState.teamContext!.teammates[leadAgentId]?.name || 'team-lead'
  }

  logForDebugging(
    `[SwarmMailbox] getTeammateMailboxAttachments called: envAgentName=${envAgentName}, isTeamLead=${teamLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`,
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
    viewedTeammate || isInProcessTeammate()
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

  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        const teammateToRemove = resolveShutdownApprovedVictim(m.from, shutdownApproval!)
        if (!teammateToRemove) {
          logForDebugging(
            `[SwarmMailbox] Ignoring shutdown_approved: in-body from "${shutdownApproval!.from}" != verified sender "${m.from}"`,
          )
          continue
        }
        logForDebugging(
          `[SwarmMailbox] Processing shutdown_approved from ${teammateToRemove}`,
        )

        const teammateId = appState.teamContext?.teammates
          ? Object.entries(appState.teamContext!.teammates).find(
              ([, t]) => t.name === teammateToRemove,
            )?.[0]
          : undefined

        if (teammateId) {
          removeTeammateFromTeamFile(teamName!, {
            agentId: teammateId,
            name: teammateToRemove!,
          })
          logForDebugging(
            `[SwarmMailbox] Removed ${teammateToRemove} from team file`,
          )

          await unassignTeammateTasks(
            teamName!,
            teammateId!,
            teammateToRemove!,
            'shutdown',
          )

          toolUseContext.setAppState(prev => {
            if (!prev.teamContext?.teammates) return prev
            if (!(teammateId! in prev.teamContext.teammates)) return prev
            const { [teammateId!]: _, ...remainingTeammates } =
              prev.teamContext.teammates
            return {
              ...prev,
              teamContext: {
                ...prev.teamContext,
                teammates: remainingTeammates,
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

export function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName()
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
