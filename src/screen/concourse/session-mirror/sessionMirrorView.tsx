import React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import ScrollBox, { type ScrollBoxHandle } from '../../renderer/elements/ScrollBox.js'
import { TerminalSizeContext } from '../../renderer/elements/TerminalSizeContext.js'
import type { getTools } from '../../../tools/kit/toolList.js'
import type { RenderableMessage } from '../../../engine/message-shapes/message.js'
import type { Screen } from '../../chat/Chat.js'
import { EMPTY_STRING_SET } from '../../../engine/messages/messages.js'
import { hasContentAfterIndex, MessageRow } from '../../messages/MessageRow.js'
import { RowErrorBoundary } from '../../messages/RowErrorBoundary.js'
import type { controlNoteOf } from '../contracts.js'
import { isAssistantContinuationRow } from '../../messages/Messages.js'
import { AttachedAttributionContext, NameplateAccentContext, NameplateContinuationContext } from '../../messages/TranscriptNameplate.js'
import { GLYPH, truncateToWidth } from '../../theme/glyphs.js'
import type { mirrorHeaderFit } from '../mirrorHeader.js'
import { WorkingGlyph } from '../../widgets/LiveGlyphs.js'
import { InteractiveRow } from '../../widgets/InteractiveRow.js'
import type { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import type { deriveTranscriptRows, useCoordinatorAttribution, useWorkerTranscriptFold } from '../workerTranscriptFold.js'
import type { SessionReceiptEntry } from '../../../daemon/switchboard/sessionReceipts.js'

export function sessionMirrorView({ t, identityInk, fold, classifyAttribution, tools, derived, turnLive, canAnimate, scrollRef, away, jumpNewest, newSince, receiptsNewestFirst, receiptPlan, hintVisible, noteView, noteText, clusterReserve, titleShown, factsShown, nowShown, paneSize, paneRows, paneWidth, focused, onEnter, state, bare, liveTailLine, idScope, receiptRowText }: { t: ReturnType<typeof useMercuryTokens>; identityInk: string; fold: ReturnType<typeof useWorkerTranscriptFold>['fold']; classifyAttribution: ReturnType<typeof useCoordinatorAttribution>; tools: ReturnType<typeof getTools>; derived: ReturnType<typeof deriveTranscriptRows>; turnLive: boolean; canAnimate: boolean; scrollRef: React.RefObject<ScrollBoxHandle | null>; away: boolean; jumpNewest: () => void; newSince: number; receiptsNewestFirst: SessionReceiptEntry[]; receiptPlan: { shown: number; deepFirst: boolean; olderLine: boolean } | null; hintVisible: boolean; noteView: ReturnType<typeof controlNoteOf> | undefined; noteText: string | null; clusterReserve: number; titleShown: string; factsShown: ReturnType<typeof mirrorHeaderFit>['factsShown']; nowShown: ReturnType<typeof mirrorHeaderFit>['nowText']; paneSize: { columns: number; rows: number }; paneRows: number; paneWidth: number; focused: boolean; onEnter: (() => void) | undefined; state: string | undefined; bare: boolean; liveTailLine: string | null | undefined; idScope: string; receiptRowText: (e: SessionReceiptEntry) => string }) {
  return (
    <TerminalSizeContext.Provider value={paneSize}>
    <Box flexDirection="column" height={paneRows} width={paneWidth} flexShrink={0} overflow="hidden">
      {bare ? null : (
      <Box height={1} flexShrink={0} overflow="hidden">
        <InteractiveRow
          id={`${idScope}:title`}
          directActivate
          hoverStyle="chrome-ink"
          flexGrow={1}
          onActivate={onEnter}
        >
          {hover => (
            <Box flexDirection="row" width="100%" overflow="hidden">
              <Text wrap="truncate-end">
                <Text color={identityInk}>{titleShown}</Text>
                {factsShown.length > 0 ? <Text color={t.textSecondary}>{factsShown}</Text> : null}
              </Text>
              <Box flexGrow={1} />
              {noteView !== undefined && noteText !== null ? (
                <Text
                  color={
                    noteView.state === 'refused' || noteView.state === 'failed'
                      ? t.failureText
                      : noteView.state === 'applied'
                        ? t.success
                        : t.textInstruction
                  }
                  wrap="truncate-end"
                >
                  {truncateToWidth(noteText, clusterReserve)}
                </Text>
              ) : hintVisible ? (
                <Box flexDirection="row" overflow="hidden">
                  {state === 'working' ? (
                    <Box flexDirection="row" marginRight={1} overflow="hidden">
                      <WorkingGlyph color={t.info} active />
                      {nowShown !== null ? (
                        <Text color={t.textInstruction} wrap="truncate-end">
                          {' '}
                          {nowShown}
                        </Text>
                      ) : null}
                    </Box>
                  ) : null}
                  <Text color={hover || focused ? t.textPrimary : t.textMuted}>
                    ↵ enter session
                  </Text>
                </Box>
              ) : null}
            </Box>
          )}
        </InteractiveRow>
      </Box>
      )}
      {fold === null || derived.collapsed.length === 0 ? (
        <Box flexDirection="column" flexGrow={1} marginTop={bare ? 0 : 1}>
          <Text color={t.textMuted}>
            {state === 'parked'
              ? 'parked — ↵ brings it back'
              : state === 'ready-to-review'
                ? 'no chat yet — ready for your first words · ↵ enters it'
                : 'no chat yet — the session is starting'}
          </Text>
        </Box>
      ) : (
        <AttachedAttributionContext.Provider value={classifyAttribution}>
          <NameplateAccentContext.Provider value={identityInk}>
            <ScrollBox ref={scrollRef} stickyScroll flexGrow={1} flexDirection="column" marginTop={bare ? 0 : 1}>
              {fold.shed > 0 ? (
                <Text color={t.textMuted} wrap="truncate-end">
                  {GLYPH.dot} older history capped here — {fold.shed} earlier record
                  {fold.shed === 1 ? '' : 's'} stay in the session&apos;s transcript
                </Text>
              ) : null}
              {derived.collapsed.map((m, i) => (
                <NameplateContinuationContext.Provider
                  key={m.uuid}
                  value={isAssistantContinuationRow(derived.collapsed, i)}
                >
                  {}
                  <RowErrorBoundary>
                  <MessageRow
                    message={m}
                    isUserContinuation={m.type === 'user' && derived.collapsed[i - 1]?.type === 'user'}
                    hasContentAfter={
                      m.type === 'collapsed_read_search' &&
                      hasContentAfterIndex(
                        derived.collapsed as RenderableMessage[],
                        i,
                        tools,
                        EMPTY_STRING_SET as Set<string>,
                      )
                    }
                    tools={tools}
                    commands={[]}
                    verbose={false}
                    inProgressToolUseIDs={derived.inProgress}
                    streamingToolUseIDs={EMPTY_STRING_SET as Set<string>}
                    screen={'prompt' as Screen}
                    canAnimate={canAnimate}
                    lastThinkingBlockId={null}
                    latestBashOutputUUID={null}
                    columns={paneWidth}
                    isLoading={turnLive}
                    lookups={derived.lookups}
                  />
                  </RowErrorBoundary>
                </NameplateContinuationContext.Provider>
              ))}
            </ScrollBox>
          </NameplateAccentContext.Provider>
        </AttachedAttributionContext.Provider>
      )}
      {receiptPlan !== null ? (
        <Box flexDirection="column" flexShrink={0} overflow="hidden">
          <Box height={1} overflow="hidden">
            <Text color={t.textMuted} wrap="truncate-end">
              {GLYPH.dot} receipt · {receiptsNewestFirst.length}{' '}
              {receiptsNewestFirst.length === 1 ? 'entry' : 'entries'}
            </Text>
          </Box>
          {receiptsNewestFirst.slice(0, receiptPlan.shown).map((e, i) => {
            const deep = i === 0 && receiptPlan.deepFirst
            const text = receiptRowText(e)
            return (
              <Box key={`${e.at}:${e.kind}:${i}`} height={deep ? 2 : 1} overflow="hidden">
                <Text
                  color={e.kind === 'machine-floor' ? t.textMuted : t.textSecondary}
                  wrap={deep ? 'wrap' : 'truncate-end'}
                >
                  {deep ? truncateToWidth(text, Math.max(16, paneWidth * 2 - 2)) : text}
                </Text>
              </Box>
            )
          })}
          {receiptPlan.olderLine ? (
            <Box height={1} overflow="hidden">
              <Text color={t.textMuted} wrap="truncate-end">
                +{receiptsNewestFirst.length - receiptPlan.shown} older
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {liveTailLine !== undefined && liveTailLine !== null && liveTailLine.length > 0 ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={t.textMuted} wrap="truncate-start">
            {GLYPH.dot} {liveTailLine}
          </Text>
        </Box>
      ) : null}
      {away ? (
        <Box height={1} flexShrink={0}>
          <InteractiveRow id={`${idScope}:jump-newest`} directActivate hoverStyle="row-fill" onActivate={jumpNewest}>
            {hover => (
              <Text
                color={hover ? t.textPrimary : newSince > 0 ? t.warning : t.textMuted}
                wrap="truncate-end"
              >
                ↓ {newSince > 0 ? `+${newSince} new · ` : ''}return to newest
              </Text>
            )}
          </InteractiveRow>
        </Box>
      ) : null}
    </Box>
    </TerminalSizeContext.Provider>
  )
}
