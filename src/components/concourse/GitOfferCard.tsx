import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'
import type { ConcourseSnapshotV1 } from './contracts.js'

// ============================================================================
//  GitOfferCard — operator items 1–3: the coordinator's git offer answers on
//  the STANDARD consent card, inline at the bottom of the coordinator pane
//  (the mini-REPL grammar — ask-and-answer in place, permissions at the
//  bottom where muscle memory expects them; the rail row remains a mention).
//
//  REUSE, never a lookalike: this file composes the estate's real card
//  owners VERBATIM — PermissionDialog (the one consent frame every card
//  mounts: amber attention border, mode chip, queue marker, attribution)
//  and PermissionPrompt (the one option grammar: the Select flow, the bold
//  ask, '↑↓ choose · ↵ confirm · esc cancel'). The body follows the generic
//  card's `name(args)` line + dim description, and it names the EXACT
//  folder the git init lands in (the full path).
//
//  The option set is the subset that is REAL for a daemon-local ask: the
//  per-tool cards' always-allow leg persists a permission rule the git-init
//  answer path ignores (answerPermissionAsk executes init directly and
//  future offers are minted regardless of host rules), so offering it here
//  would be a dead affordance — Yes and No (esc) are the honest options,
//  wired through the same answer-permission door the rail's y/n rode.
// ============================================================================

export interface GitOfferV1 {
  /** The daemon ask id (`git-init:<sha>` — the obligation ref minus its
   *  `permission:` prefix). */
  requestId: string
  obligationId: string
  /** The EXACT folder the git init lands in (from the obligation's
   *  `folder:<dir>` subject). */
  folder: string
  /** THE RULED No LEG's split fact (board controls item 5): whether a live
   *  claim holds the folder at paint. FREE ⇒ No runs the session there as
   *  it is, alone (the daemon's deny-proceed replay); HELD ⇒ No keeps the
   *  launch queued until the folder frees or git lands. Composed by the
   *  screen from the snapshot (gitOfferFolderHeld); absent reads as free. */
  folderHeld?: boolean
}

/** The board-side derivation of the split fact: a live-state row claiming
 *  the folder on THIS board, or another project's activity line naming it
 *  with runners — the paint-time mirror of the daemon's own claim fold
 *  (the deny receipt remains the settled truth either way). */
export function gitOfferFolderHeld(
  snapshot: Pick<ConcourseSnapshotV1, 'groups' | 'elsewhere'>,
  folder: string,
): boolean {
  // The states that hold a workspace claim — the admission's liveWorkers
  // approximation as the board sees it (parked/stopped/queued hold none).
  const CLAIM_STATES: ReadonlyArray<string> = ['working', 'needs-you', 'stalled', 'paused', 'ready-to-review', 'attached', 'starting']
  const rowHolds = snapshot.groups.some(g =>
    g.rows.some(r => r.workspaceDir === folder && CLAIM_STATES.includes(r.state)),
  )
  const elsewhereHolds = (snapshot.elsewhere ?? []).some(p => p.dir === folder && p.running > 0)
  return rowHolds || elsewhereHolds
}

/** The No leg's label — the ruled split, one owner. Short enough for the
 *  wide pane's option row (~37 text cols; the description below carries
 *  the full ruled sentence for each leg). */
export function gitOfferNoLabel(folderHeld: boolean): string {
  return folderHeld ? 'No, keep the folder as it is (esc)' : 'No — run here as it is, alone (esc)'
}

/** The card's description — ONE composer; the screen's height mirror
 *  derives from this SAME string (derive, never duplicate). Each leg tells
 *  only its truth: a FREE folder's No runs the session there as it is,
 *  alone (no isolated copy); a HELD folder's No keeps the launch queued. */
export function gitOfferDescription(folder: string, folderHeld: boolean): string {
  const base = `creates the repository (plus one base commit) in ${folder} so sessions can fork it — the launch held on this folder starts on its own. `
  return folderHeld
    ? `${base}Saying No keeps the folder as it is: the launch stays queued until the folder frees or git lands`
    : `${base}Saying No runs the session in this folder as it is, alone — no isolated copy is made`
}

/** The pure derivation the screen arms the card from: the OLDEST open
 *  git-init permission obligation (needsYou is oldest-first), its ask id
 *  and its exact folder — from the row's `folder:<dir>` subject, never
 *  parsed out of prose. Exported so the prover pins it. */
export function deriveGitOffer(
  needsYou: ReadonlyArray<{ obligationId: string; sessionId: string; ref?: string }>,
): GitOfferV1 | undefined {
  const row = needsYou.find(
    o => o.ref?.startsWith('permission:git-init:') === true && o.sessionId.startsWith('folder:'),
  )
  if (row?.ref === undefined) return undefined
  return {
    requestId: row.ref.slice('permission:'.length),
    obligationId: row.obligationId,
    folder: row.sessionId.slice('folder:'.length),
  }
}

type GitOfferAnswer = 'yes' | 'no'

export function GitOfferCard({
  offer,
  onAnswer,
}: {
  offer: GitOfferV1
  /** Rides the existing answer-permission wire (allow executes git init +
   *  one base commit daemon-side; deny keeps the folder untouched with the
   *  launch queued). */
  onAnswer: (requestId: string, allow: boolean, obligationId: string) => void
}): React.ReactNode {
  // Memoised like every estate card's option list: a fresh array per render
  // re-seeds the Select's focus (it re-asserts focus when its options
  // change), which would snap ↓'s move back onto Yes on the next repaint.
  const folderHeld = offer.folderHeld === true
  const options = useMemo<PermissionPromptOption<GitOfferAnswer>[]>(
    () => [
      { label: 'Yes', value: 'yes' },
      // The ruled No leg — each state's own truth (the split fact above).
      { label: gitOfferNoLabel(folderHeld), value: 'no' },
    ],
    [folderHeld],
  )
  const answer = (allow: boolean): void => onAnswer(offer.requestId, allow, offer.obligationId)
  return (
    // flexShrink=0 on the card and on every line: inside a height-bound pane
    // yoga otherwise squeezes the card's first row to zero height (the
    // driven 120×40 capture lost the `git init(…)` line under the
    // description) — the card never shrinks; the transcript above it does.
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog title="Start a git repository">
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text wrap="wrap">
              git init(<Text bold>{offer.folder}</Text>)
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor wrap="wrap">
              {gitOfferDescription(offer.folder, folderHeld)}
            </Text>
          </Box>
          <PermissionPrompt
            options={options}
            onSelect={value => answer(value === 'yes')}
            onCancel={() => answer(false)}
          />
        </Box>
      </PermissionDialog>
    </Box>
  )
}
