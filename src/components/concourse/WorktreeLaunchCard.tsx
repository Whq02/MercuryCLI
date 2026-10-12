import React, { useMemo } from 'react'
import { Box, Text } from '../../ink.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'

export const WORKTREE_LAUNCH_TITLE = 'A worktree for this session'

export function worktreeLaunchLine(folder: string, holderTitle: string | null): string {
  const holder = holderTitle !== null && holderTitle.length > 0 ? `“${holderTitle}”` : 'another live session'
  return `${folder} is already held by ${holder} — this session would start on a worktree of its own: a second checkout of the repository on a new branch (mercury/…). Its edits land on that branch, not on the checkout you are in.`
}

type WorktreeLaunchAnswer = 'yes' | 'no'

export function WorktreeLaunchCard({
  folder,
  holderTitle,
  onAnswer,
}: {
  folder: string
  holderTitle: string | null
  onAnswer: (allowed: boolean) => void
}): React.ReactNode {
  const options = useMemo<PermissionPromptOption<WorktreeLaunchAnswer>[]>(
    () => [
      { label: 'Yes — start it on a worktree and its own branch', value: 'yes' },
      { label: 'No, start nothing (esc)', value: 'no' },
    ],
    [],
  )
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog title={WORKTREE_LAUNCH_TITLE}>
        <Box flexDirection="column" flexShrink={0}>
          <Box flexShrink={0}>
            <Text wrap="wrap">
              a new session in <Text bold>{folder}</Text> would fork a worktree
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor wrap="wrap">
              {worktreeLaunchLine(folder, holderTitle)} Yes starts it there (the launch receipt names the
              branch). No starts nothing — your words stay in the composer.
            </Text>
          </Box>
          <PermissionPrompt
            options={options}
            onSelect={value => onAnswer(value === 'yes')}
            onCancel={() => onAnswer(false)}
          />
        </Box>
      </PermissionDialog>
    </Box>
  )
}
