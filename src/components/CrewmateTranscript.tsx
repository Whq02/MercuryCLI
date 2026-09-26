import * as React from 'react'
import { useLayoutEffect, useRef } from 'react'
import type { Command } from '../commands.js'
import { Box, Text } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { Tools } from '../Tool.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { operatorPlateName } from '../utils/cockpit/crewmateWords.js'
import { Messages } from './Messages.js'
import { CrewmatePlateContext } from './messages/TranscriptNameplate.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { CREWMATE_TRANSCRIPT_EMPTY, CREWMATE_TRANSCRIPT_READING, useCrewmateTranscript } from './tasks/useCrewmateTranscript.js'
import { useViewedCrewmate } from './tasks/useCrewmateView.js'
import { useFocusedWorkRoster } from './tasks/useFocusedWork.js'

const NO_CONFIRMS: unknown[] = []
const NO_IDS = new Set<string>()
const NO_STREAMING: never[] = []

export type TranscriptSwapProps = {
  lead: React.ReactNode
  tools: Tools
  commands: Command[]
  screen: 'prompt' | 'transcript'
  agentDefinitions?: AgentDefinitionsResult
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  showAllInTranscript?: boolean
  trackStickyPrompt?: boolean
}

export type ScrollMemory = { top: number; sticky: boolean }

export function rememberScroll(handle: ScrollBoxHandle | null): ScrollMemory | null {
  if (handle === null) return null
  return { top: handle.getScrollTop(), sticky: handle.isSticky() }
}

export function restoreScroll(handle: ScrollBoxHandle | null, memory: ScrollMemory | null): void {
  if (handle === null) return
  if (memory === null || memory.sticky) handle.scrollToBottom()
  else handle.scrollTo(memory.top)
}

export const LEAD_VIEW_KEY = ''

export function TranscriptSwap({ lead, tools, commands, screen, agentDefinitions, scrollRef, showAllInTranscript = false, trackStickyPrompt = false }: TranscriptSwapProps): React.ReactNode {
  const crewmate = useViewedCrewmate()
  const roster = useFocusedWorkRoster()
  const transcript = useCrewmateTranscript(crewmate, roster)
  const tokens = useMercuryTokens()
  const memories = useRef(new Map<string, ScrollMemory>())
  const shown = useRef<string>(LEAD_VIEW_KEY)
  const viewKey = crewmate?.taskId ?? LEAD_VIEW_KEY
  useLayoutEffect(() => {
    if (viewKey === shown.current) return
    const handle = scrollRef?.current ?? null
    const left = rememberScroll(handle)
    if (left !== null) memories.current.set(shown.current, left)
    restoreScroll(handle, memories.current.get(viewKey) ?? null)
    shown.current = viewKey
  }, [viewKey, scrollRef])
  if (crewmate === null || transcript === null) return lead
  const plates = { agent: crewmate.name, user: operatorPlateName(crewmate.name) }
  return (
    <CrewmatePlateContext.Provider value={plates}>
      <Box flexDirection="column">
        {transcript.state !== 'ready' ? (
          <Box paddingLeft={1} marginTop={1}>
            <Text color={tokens.textMuted}>{transcript.state === 'reading' ? CREWMATE_TRANSCRIPT_READING : CREWMATE_TRANSCRIPT_EMPTY}</Text>
          </Box>
        ) : (
          <Messages
            messages={transcript.messages}
            tools={tools}
            commands={commands}
            verbose
            toolJSX={null}
            toolUseConfirmQueue={NO_CONFIRMS}
            inProgressToolUseIDs={NO_IDS}
            isMessageSelectorVisible={false}
            conversationId={`crewmate:${crewmate.taskId}`}
            screen={screen}
            streamingToolUses={NO_STREAMING}
            showAllInTranscript={showAllInTranscript}
            agentDefinitions={agentDefinitions}
            isLoading={false}
            streamingThinking={null}
            hidePastReasoning
            streamingTail={null}
            scrollRef={scrollRef}
            trackStickyPrompt={trackStickyPrompt}
            disableRenderCap
          />
        )}
        <Box flexGrow={1} />
      </Box>
    </CrewmatePlateContext.Provider>
  )
}
