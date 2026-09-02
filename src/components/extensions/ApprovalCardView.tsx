// ============================================================================
//  ApprovalCardView — the approval card (spec 05 §6.1, 03 §2.2). The BODY is
//  card.ts approvalCardLines VERBATIM — the CLI's consent card and this
//  board paint the SAME lines from the same owner; this view only colours
//  them (section titles bold, +/− diff gutters in their roles) and arms the
//  exits: ↵ approve everywhere · p this project · k keep installed, off ·
//  x uninstall (a project folder: x forget) · esc back. A diff card's esc/k
//  leaves the old version active (the core removes the fetched folder).
// ============================================================================
import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import ScrollBox from '../../ink/components/ScrollBox.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { approvalCardLines } from '../../extensions/card.js'
import { readManifest, type ExtensionManifest } from '../../extensions/manifest.js'
import { isOptionSet } from '../../extensions/options.js'
import { decodeNavKey } from '../mercury-ui/navSemantics.js'
import { ProductLockup } from '../mercury-ui/components.js'
import { packFooter } from '../mercury-ui/footerHint.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import type { CardSpec } from './ExtensionsBoard.js'

const SECTION_TITLES = new Set(['runs on your machine', 'reaches the model', 'needs'])

export function ApprovalCardView({
  card,
  onApprove,
  onKeep,
  onUninstall,
  onBack,
}: {
  card: CardSpec
  onApprove: (scope: 'everywhere' | 'project') => void
  onKeep: () => void
  onUninstall: () => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns: cols, rows: termRows } = useTerminalSize()
  const pastGate = useOpenEventGate()

  // The one card owner: card.ts. Reading the manifests here keeps the lines
  // live — the card always shows the copy on disk, never a stale snapshot.
  const built = React.useMemo((): { lines: string[]; error: string | null; title: string; version: string | null } => {
    const read = readManifest(card.root)
    if (read.status !== 'ok') {
      return {
        lines: [],
        error: read.status === 'missing' ? `no mercury-extension.json at ${card.root}` : `manifest invalid: ${read.errors[0] ?? 'unknown'}`,
        title: card.id,
        version: null,
      }
    }
    let previous: { manifest: ExtensionManifest; root: string; version: string } | null = null
    if (card.previous) {
      const prev = readManifest(card.previous.root)
      if (prev.status === 'ok') previous = { manifest: prev.manifest, root: card.previous.root, version: card.previous.version }
    }
    const lines = approvalCardLines({
      manifest: read.manifest,
      root: card.root,
      kind: card.cardKind,
      from: { label: card.label, where: card.where, commit: card.commit },
      previous,
      optionSet: key => isOptionSet(card.id, read.manifest.needs?.options, key),
    })
    const title = lines[0] ?? `approve ${card.id}`
    return { lines: lines.slice(1), error: null, title, version: read.manifest.version }
  }, [card])

  useInput((input, key) => {
    const action = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true })
    if (action === 'cancel' || action === 'leaveChild') {
      onBack()
      return
    }
    // Modifier chords never fire single-char actions (the chassis's law).
    if (key.ctrl || key.meta) return
    if (!pastGate()) return
    if (built.error !== null) return
    if (action === 'activate') onApprove('everywhere')
    else if (input === 'p' && card.cardKind !== 'update') onApprove('project')
    else if (input === 'k') onKeep()
    else if (input === 'x') onUninstall()
  })

  const isUpdate = card.cardKind === 'update'
  // On an update card `k` and `esc` are the SAME act (the core's discardUpdate:
  // the running version stays, the fetched folder is removed) — the rail says
  // so, in both words, instead of a `keep` that hides the drop.
  const fetched = built.version ?? 'the fetched copy'
  const footer = [
    '↵ approve',
    !isUpdate ? 'p approve for this project only' : null,
    isUpdate ? `k keep ${card.previous?.version ?? 'the current version'} (removes the fetched ${fetched})` : 'k keep installed, off',
    card.cardKind === 'project folder' ? 'x forget' : 'x uninstall',
    isUpdate ? 'esc back (same as k)' : 'esc back',
  ]
    .filter(Boolean)
    .join(' · ')

  const bodyHeight = Math.max(3, termRows - 6)

  return (
    <AlternateScreen>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tokens.accent}
        paddingX={1}
        width="100%"
        flexShrink={0}
        minHeight={Math.max(0, termRows - 1)}
      >
        <Box flexShrink={0} height={1} overflow="hidden">
          <ProductLockup view="extensions" subtitle={built.title.replace(/\s+\(.*\)$/, '')} />
          <Box flexGrow={1} />
          <Text color={tokens.textMuted}>{card.cardKind}</Text>
        </Box>
        <ScrollBox height={bodyHeight} flexShrink={0} flexDirection="column">
          <Box flexDirection="column" marginTop={1}>
            {built.error !== null ? (
              <Text color={tokens.failure}>{built.error}</Text>
            ) : (
              // The frame's interior is cols − 4 (border + padding each side): a
              // section rule runs to the padding, not two cells short of it.
              built.lines.map((line, i) => <CardLine key={i} line={line} width={Math.max(10, cols - 4)} />)
            )}
          </Box>
        </ScrollBox>
        <Box flexGrow={1} />
        <Box marginTop={1} flexShrink={0} height={1} overflow="hidden">
          <Text color={tokens.textMuted} wrap="truncate-end">
            {packFooter(footer, Math.max(0, cols - 4))}
          </Text>
        </Box>
      </Box>
    </AlternateScreen>
  )
}

function CardLine({ line, width }: { line: string; width: number }): React.ReactNode {
  const tokens = useMercuryTokens()
  if (line === '') return <Box height={1} />
  if (SECTION_TITLES.has(line)) {
    const rule = '─'.repeat(Math.max(0, Math.min(width - line.length - 1, 200)))
    return (
      <Box height={1} overflow="hidden">
        <Text bold color={tokens.textSecondary}>
          {line}{' '}
        </Text>
        <Text color={tokens.borderSubtle}>{rule}</Text>
      </Box>
    )
  }
  if (line === 'nothing above runs until you approve') {
    return (
      <Text bold color={tokens.warning} wrap="truncate-end">
        {line}
      </Text>
    )
  }
  const mark = line.startsWith('  + ') ? '+' : line.startsWith('  − ') ? '−' : null
  return (
    <Text
      color={mark === '+' ? tokens.success : mark === '−' ? tokens.failure : tokens.textPrimary}
      wrap="truncate-end"
    >
      {line}
    </Text>
  )
}
