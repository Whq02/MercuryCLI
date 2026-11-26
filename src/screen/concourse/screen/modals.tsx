import React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import { useRegisterOverlay } from '../../overlays/overlayHooks.js'
import { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import { browseKeysFor, CONCOURSE_HELP_KEY, managerPaneKeysFor, regionKeysFor, withoutManagerPaneKeys, type BoardSelectionClass } from '../controlManifest.js'
import { InteractiveRow } from '../../widgets/InteractiveRow.js'
import { gitOfferDescription } from '../GitOfferCard.js'
import { FloatingPopup } from '../../overlays/PopupGutter.js'
import { displayWidth } from '../../theme/glyphs.js'
import { keyHintLabel } from '../../widgets/keyHintLabel.js'
import { splitAvailableAt } from '../splitView.js'

export function gitOfferCardRows(folder: string, interior: number, folderHeld: boolean): number {
  const textCols = Math.max(20, interior - 4)
  const descLen = gitOfferDescription(folder, folderHeld).length
  const gitLines = Math.max(1, Math.ceil((`git init(${folder})`.length) / textCols))
  const descLines = Math.max(1, Math.ceil(descLen / textCols))
  return 9 + gitLines + descLines
}

export function TrustAskModal({
  cols,
  rows,
  dir,
  onAnswer,
}: {
  cols: number
  rows: number
  dir: string
  onAnswer: (trusted: boolean) => void
}): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-trust-ask')
  const width = Math.min(70, Math.max(44, cols - 8))
  return (
    <FloatingPopup host={{ left: 0, top: 0, columns: cols, rows }} width={width} top={Math.floor(rows / 2) - 5} borderColor={t.warning} paddingX={2}>
      <Box height={1} flexShrink={0}>
        <Text bold color={t.warning} wrap="truncate-end">
          UNTRUSTED FOLDER — trust check
        </Text>
      </Box>
      <Box flexShrink={0} marginTop={1} flexDirection="column">
        <Text color={t.textPrimary} wrap="wrap">
          Mercury has not been trusted with {dir} before. Sessions launched there run its code and
          read its settings.
        </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <InteractiveRow id="concourse:trust-ask:allow" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(true)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.warning} bold>
                y
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> trust this folder — switch to it</Text>
            </Text>
          )}
        </InteractiveRow>
        <InteractiveRow id="concourse:trust-ask:decline" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(false)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.warning} bold>
                n
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> keep the current ground — nothing changes</Text>
            </Text>
          )}
        </InteractiveRow>
      </Box>
      <Box height={1} flexShrink={0} marginTop={1}>
        <Text color={t.textInstruction} wrap="truncate-end">
          esc keeps the current ground · the grant persists in the trust ledger
        </Text>
      </Box>
    </FloatingPopup>
  )
}

export function CapacityAskModal({
  cols,
  rows,
  onAnswer,
}: {
  cols: number
  rows: number
  onAnswer: (allowed: boolean) => void
}): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-capacity-ask')
  const width = Math.min(64, Math.max(44, cols - 8))
  return (
    <FloatingPopup host={{ left: 0, top: 0, columns: cols, rows }} width={width} top={Math.floor(rows / 2) - 5} borderColor={t.info} paddingX={2}>
      <Box height={1} flexShrink={0}>
        <Text bold color={t.info} wrap="truncate-end">
          FIRST BOOT — capacity check
        </Text>
      </Box>
      <Box flexShrink={0} marginTop={1}>
        <Text color={t.textPrimary} wrap="wrap">
          may I run a one-time check of this machine (cores, memory, other running agent CLIs) to
          size how many parallel sessions fit?
        </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <InteractiveRow id="concourse:capacity-ask:allow" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(true)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.info} bold>
                y
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> run it once</Text>
            </Text>
          )}
        </InteractiveRow>
        <InteractiveRow id="concourse:capacity-ask:decline" directActivate hoverStyle="row-fill" onActivate={() => onAnswer(false)}>
          {(hover: boolean) => (
            <Text wrap="truncate-end">
              <Text color={t.info} bold>
                n
              </Text>
              <Text color={hover ? t.textPrimary : t.textSecondary}> no probe — the machine's own reading decides</Text>
            </Text>
          )}
        </InteractiveRow>
      </Box>
      <Box height={1} flexShrink={0} marginTop={1}>
        <Text color={t.textInstruction} wrap="truncate-end">
          esc keeps the default · asked once, never again
        </Text>
      </Box>
    </FloatingPopup>
  )
}

export function ConcourseKeyAtlas({ cols, rows, chat, reducedStage = false, splitOn = false, selection }: { cols: number; rows: number; chat: boolean; reducedStage?: boolean; splitOn?: boolean; selection?: BoardSelectionClass }): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-help')
  const stage = { newSession: !reducedStage }
  const listStage = selection !== undefined && selection !== 'none' ? { ...stage, selection } : stage
  const sections: Array<{ title: string; keys: ReadonlyArray<{ keys: string; label: string }> }> = [
    { title: 'BROWSE', keys: [...browseKeysFor({ chatPresent: chat }), CONCOURSE_HELP_KEY] },
    { title: 'NEEDS YOU (rail)', keys: regionKeysFor('rail', stage) },
    { title: 'SESSIONS (list)', keys: [...managerPaneKeysFor({ ...stage, paused: selection === 'paused' }), ...withoutManagerPaneKeys(regionKeysFor('list', listStage))] },
    { title: 'LIVE VIEW (its composer)', keys: regionKeysFor('live', stage) },
    ...(!reducedStage && splitAvailableAt(cols, rows)
      ? [
          splitOn
            ? { title: 'SPLIT VIEW (s toggles)', keys: regionKeysFor('chat', { ...stage, chatSession: chat }) }
            : { title: 'SPLIT VIEW (s toggles)', keys: [{ keys: 's', label: 'split view' }] },
        ]
      : []),
  ]
  const composedHeight = (list: typeof sections, marker: boolean): number =>
    list.reduce((n, s) => n + 1 + s.keys.length, 0) +
    Math.max(0, list.length - 1) +
    3 +
    2  +
    (marker ? 1 : 0)
  const maxHeight = Math.max(7, rows - 2)
  let shown = sections
  let hiddenSections = 0
  while (shown.length > 1 && composedHeight(shown, hiddenSections > 0) > maxHeight) {
    shown = shown.slice(0, -1)
    hiddenSections++
  }
  const height = composedHeight(shown, hiddenSections > 0) - 2
  const keyCol = Math.max(12, ...sections.flatMap(s => s.keys.map(k => displayWidth(keyHintLabel(k.keys)) + 1)))
  const width = 46 + (keyCol - 12)
  return (
    <FloatingPopup host={{ left: 0, top: 0, columns: cols, rows }} width={width} top={Math.floor((rows - height) / 2)} borderColor={t.info} paddingX={2}>
      <Box height={1} flexShrink={0}>
        <Text bold color={t.info} wrap="truncate-end">
          CONCOURSE — keys
        </Text>
      </Box>
      {shown.map((s, si) => (
        <Box key={s.title} flexDirection="column" flexShrink={0} marginTop={si === 0 ? 0 : 1}>
          <Text color={t.infoText} bold wrap="truncate-end">
            {s.title}
          </Text>
          {s.keys.map(k => (
            <Box key={`${s.title}:${k.keys}`} height={1} flexShrink={0}>
              <Box width={keyCol} flexShrink={0}>
                <Text color={t.textPrimary}>{keyHintLabel(k.keys)}</Text>
              </Box>
              <Text color={t.textInstruction} wrap="truncate-end">
                {k.label}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {hiddenSections > 0 ? (
        <Box height={1} flexShrink={0} marginTop={1}>
          <Text color={t.textMuted} wrap="truncate-end">
            {`… ${hiddenSections} more section${hiddenSections === 1 ? '' : 's'} — grow the window`}
          </Text>
        </Box>
      ) : null}
      <Box height={1} flexShrink={0} marginTop={hiddenSections > 0 ? 0 : 1}>
        <Text color={t.textInstruction} wrap="truncate-end">
          esc close
        </Text>
      </Box>
    </FloatingPopup>
  )
}
