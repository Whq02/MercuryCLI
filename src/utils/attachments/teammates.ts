// Teammate attachments — the swarm mailbox drain (dual-source with dedup,
// scoped mark-as-read, shutdown-approval processing bound to the VERIFIED
// envelope sender) and the first-turn team-context card. The mailbox body is
// folded dead in this build (unconditional return after the gate) — moved
// exactly; Phase-8 decides its fate.

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

/**
 * The swarm mailbox drain — peer messages between independent parallel
 * Mercury sessions (teammates, not parent-child subagents), delivered into
 * the turn as an attachment. FOLDED DEAD in this build (the unconditional
 * return after the swarms gate); the body below is kept whole for the
 * Phase-8 decision.
 *
 * Two sources feed one attachment: the file mailbox (messages that landed
 * between polls) and AppState.inbox (messages useInboxPoller queued
 * mid-turn) — merged, deduped, idle-collapsed, then marked read only in
 * the scope actually delivered.
 */
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

  // Identity resolution, all through the shared teammate helpers (each
  // walks AsyncLocalStorage → dynamicTeamContext → AppState as applicable).
  const envAgentName = getAgentName()
  const teamName = getTeamName(appState.teamContext)
  const teamLeadStatus = isTeamLead(appState.teamContext)
  const viewedTeammate = getViewedTeammateTask(appState)

  // The mailbox read follows the VIEWED identity: a teammate's transcript
  // reads that teammate's mailbox; otherwise the session's own name, with
  // the lead's name as the fallback for an unnamed lead.
  let agentName = viewedTeammate?.identity.agentName ?? envAgentName
  // `!` assertions through this function: its body is unreachable (folded
  // unconditional `return []` at the top), where tsc narrowing is inert —
  // the existing guards no longer narrow. Runtime is untouched.
  if (!agentName && teamLeadStatus && appState.teamContext) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // The human-readable name from the teammates map — never the raw UUID.
    agentName = appState.teamContext!.teammates[leadAgentId]?.name || 'team-lead'
  }

  logForDebugging(
    `[SwarmMailbox] getTeammateMailboxAttachments called: envAgentName=${envAgentName}, isTeamLead=${teamLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`,
  )

  // No resolvable identity ⇒ not in a swarm ⇒ no mailbox to read.
  if (!agentName) {
    logForDebugging(
      `[SwarmMailbox] Not checking inbox - not in a swarm or team lead`,
    )
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Checking inbox for agent="${agentName}" team="${teamName || 'default'}"`,
  )

  // Structured protocol traffic (permission requests/responses, shutdown
  // envelopes …) is NOT ours: it must stay unread for useInboxPoller to
  // route to its real handlers. The attachment drain races the poller —
  // first reader marks messages read — and if the drain won without this
  // filter, protocol envelopes would land in the model's context as raw
  // prose instead of driving their UI machinery.
  const allUnreadMessages = await readUnreadMessages(agentName!, teamName)
  const unreadMessages = allUnreadMessages.filter(
    m => !isStructuredProtocolMessage(m.text),
  )
  logForDebugging(
    `[MailboxBridge] Found ${allUnreadMessages.length} unread message(s) for "${agentName}" (${allUnreadMessages.length - unreadMessages.length} structured protocol messages filtered out)`,
  )

  // The second source — AppState.inbox — is LEADER-scoped by construction:
  // it holds messages teammates sent the leader. It only joins the drain
  // when this render IS the leader's own transcript. A viewed teammate's
  // messages already came from the file mailbox above, and an in-process
  // teammate shares the leader's AppState — draining the shared inbox from
  // its seat would leak the leader's traffic (broadcast self-echo
  // included) into the wrong context.
  const pendingInboxMessages =
    viewedTeammate || isInProcessTeammate()
      ? []
      : appState.inbox.messages.filter(m => m.status === 'pending')
  logForDebugging(
    `[SwarmMailbox] Found ${pendingInboxMessages.length} pending message(s) in AppState.inbox`,
  )

  // Merge with dedup: one message can legitimately arrive from BOTH
  // sources when the poller reads the file between this function's file
  // read and its AppState read. Identity key = sender + timestamp + text
  // prefix.
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

  // Idle notices collapse per agent to the newest one — a teammate that
  // went idle three times is one fact, not three. Parsed once, filtered by
  // index.
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

  // The attachment materializes BEFORE any mark-as-read below: if marking
  // fails, the messages are still delivered this turn and redelivered next
  // — never silently lost.
  const attachment: Attachment[] = [
    {
      type: 'teammate_mailbox',
      messages: allMessages,
    },
  ]

  // The mark-as-read runs post-build and touches ONLY the non-structured
  // rows (protocol envelopes stay unread — useInboxPoller owns them),
  // SCOPED to this snapshot's messages (the ones actually in the attachment above),
  // not a fresh `!isStructuredProtocolMessage` class scan: markMessagesAsReadByPredicate
  // re-reads under lock, so a bus envelope (non-structured) that lands between the
  // snapshot read and this mark would otherwise be marked read though never delivered
  // in the attachment ⇒ permanently lost. Mirror the foreground poll's scoped mark.
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

  // shutdown_approved handling, leader seat only: the interactive path
  // does this inside useInboxPoller, but -p mode never runs the poller —
  // this drain is where headless leaders retire approved teammates.
  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        // Bind to the VERIFIED envelope sender, not the spoofable in-body `from`
        // (review #16/#17): a teammate may only approve its OWN shutdown.
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

        // Name → teammate id, via the team map.
        const teammateId = appState.teamContext?.teammates
          ? Object.entries(appState.teamContext!.teammates).find(
              ([, t]) => t.name === teammateToRemove,
            )?.[0]
          : undefined

        if (teammateId) {
          // Retire in three strokes: team file, task ownership, AppState.
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

  // Inbox rows flip to processed LAST, for the same no-loss ordering as
  // the file-side mark above.
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

/**
 * The teammate's first-turn orientation card: who it is, which team, and
 * where the team's config and task list live on disk. One injection, ever
 * — the presence of any assistant message means the turn-0 moment passed.
 */
export function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName()

  // Teammates only — a session without team identity gets nothing.
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
