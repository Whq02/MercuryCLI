import { getSessionId, isSessionPersistenceDisabled } from '../../../boot/process-state/processState.js'
import { partyFeed } from '../../../crew/board/party.js'
import { swarmSessionEnabled, swarmStore, watchSwarmBoard, watchSwarmResumes, watchSwarmLead, enqueueBoardWake } from '../../../crew/board/seam.js'
import { peekProject, adoptResumedSessionFile, recordTranscript } from '../../../sessions/transcripts/writer.js'
import { hasConversationTurn } from '../../../sessions/resume/conversationRecovery.js'
import { getLastCacheSafeParams } from '../../../crew/agents/forkedAgent.js'
import type { ToolUseContext } from '../../../tools/kit/tool.js'
import { isShuttingDown } from '../../../platform/processes/gracefulShutdown.js'
import { crewBoardNotice } from '../../../engine/message-shapes/noticeRows.js'
import type { UUID } from 'node:crypto'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

async function run(ports: RunnerPorts): Promise<BootMade<'stopHostNotices' | 'party' | 'stopParty' | 'swarmResumes' | 'swarmLead'>> {
  const { canUseTool, live, messages, quiescence, recordHostNoticeRows } = ports
  const { watchHostNotices } = await import('../../../models/hosting/notices.js')
  const stopHostNotices = watchHostNotices(() => getSessionId())
  const party = partyFeed({
    store: () => (!live.awaitingSessionClaim && swarmSessionEnabled() ? swarmStore(false) : null),
    anchor: () => live.turnAnchor ?? undefined,
    record: async row => {
      if (messages.some(message => message.uuid === row.uuid)) return
      if ((peekProject()?.sessionFile ?? null) === null && hasConversationTurn(messages) && !isSessionPersistenceDisabled()) adoptResumedSessionFile()
      messages.push(row)
      await recordTranscript([row], undefined, messages)
    },
  })
  const stopParty = watchSwarmBoard(party.check)
  party.check()
  const swarmResumes = watchSwarmResumes(
    () => getLastCacheSafeParams()?.toolUseContext as ToolUseContext | undefined ?? null,
    canUseTool,
    () => live.sessionInitialized && !quiescence.committed && !isShuttingDown(),
  )
  const swarmLead = watchSwarmLead(
    () => live.sessionInitialized && !live.inputClosed && !isShuttingDown() && live.inFlightAbort === null,
    () => enqueueBoardWake('Read reference-only posts with CrewBoard.'),
    event => {
      if (party.paints(event) || messages.some(message => message.uuid === event.eventId)) return
      void recordHostNoticeRows([{ value: crewBoardNotice(event.authorName ?? event.author.agentId, event.kind, event.text), mode: 'task-notification', uuid: event.eventId as UUID, sentAt: event.createdAt }])
    },
  )
  return { stopHostNotices, party, stopParty, swarmResumes, swarmLead }
}

export const watchCrew: BootStep<'stopHostNotices' | 'party' | 'stopParty' | 'swarmResumes' | 'swarmLead'> = { name: 'watchCrew', makes: ['stopHostNotices', 'party', 'stopParty', 'swarmResumes', 'swarmLead'], run }
