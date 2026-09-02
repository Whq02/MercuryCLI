import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'
import type { ConcourseSnapshotV1 } from './contracts.js'


export interface GitOfferV1 {
  requestId: string
  obligationId: string
  folder: string
  folderHeld?: boolean
}

export function gitOfferFolderHeld(
  snapshot: Pick<ConcourseSnapshotV1, 'groups' | 'elsewhere'>,
  folder: string,
): boolean {
  const CLAIM_STATES: ReadonlyArray<string> = ['working', 'needs-you', 'stalled', 'paused', 'ready-to-review', 'attached', 'starting']
  const rowHolds = snapshot.groups.some(g =>
    g.rows.some(r => r.workspaceDir === folder && CLAIM_STATES.includes(r.state)),
  )
  const elsewhereHolds = (snapshot.elsewhere ?? []).some(p => p.dir === folder && p.running > 0)
  return rowHolds || elsewhereHolds
}

export function gitOfferNoLabel(folderHeld: boolean): string {
  return folderHeld ? 'No, keep the folder as it is (esc)' : 'No — run here as it is, alone (esc)'
}

export function gitOfferDescription(folder: string, folderHeld: boolean): string {
  const base = `creates the repository (plus one base commit) in ${folder} so sessions can fork it — the launch held on this folder starts on its own. `
  return folderHeld
    ? `${base}Saying No keeps the folder as it is: the launch stays queued until the folder frees or git lands`
    : `${base}Saying No runs the session in this folder as it is, alone — no isolated copy is made`
}

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
  onAnswer: (requestId: string, allow: boolean, obligationId: string) => void
}): React.ReactNode {
  const folderHeld = offer.folderHeld === true
  const options = useMemo<PermissionPromptOption<GitOfferAnswer>[]>(
    () => [
      { label: 'Yes', value: 'yes' },
      { label: gitOfferNoLabel(folderHeld), value: 'no' },
    ],
    [folderHeld],
  )
  const answer = (allow: boolean): void => onAnswer(offer.requestId, allow, offer.obligationId)
  return (
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
