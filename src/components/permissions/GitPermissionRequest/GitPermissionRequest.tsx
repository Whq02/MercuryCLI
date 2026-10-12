import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import type { GitApplyPreview } from '../../../tools/GitTool/GitTool.js'
import { plural } from '../../../utils/stringUtils.js'
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type GitInput = { op?: string; planId?: string; preview?: GitApplyPreview }

function planFor(props: PermissionRequestProps): GitApplyPreview | null {
  const input = props.toolUseConfirm.input as GitInput
  if (input.op !== 'apply' || typeof input.planId !== 'string') return null
  const preview = input.preview
  if (!preview || !Array.isArray(preview.groups) || preview.groups.length === 0) return null
  return preview
}

function GitPlanBody({ plan }: { plan: GitApplyPreview }): React.ReactNode {
  const many = plan.groups.length > 1
  return (
    <Box flexDirection="column">
      {plan.groups.map((group, index) => {
        const [subject, ...rest] = group.message.split('\n')
        const body = rest.join('\n').trim()
        return (
          <Box key={index} flexDirection="column">
            <Text>
              {many ? `Commit ${index + 1} of ${plan.groups.length}: ` : 'Commit: '}
              <Text bold>{subject}</Text>
            </Text>
            <Text>
              {'  '}
              {group.files.map(file => (group.hunks?.[file] ? `${file} (${group.hunks[file]!.length} ${plural(group.hunks[file]!.length, 'hunk')})` : file)).join(', ')}
            </Text>
            {body === '' ? null : (
              <Text dimColor>
                {'  '}
                {body}
              </Text>
            )}
          </Box>
        )
      })}
      {plan.exclusions.length > 0 ? (
        <Text dimColor>Stays uncommitted: {plan.exclusions.join(', ')}</Text>
      ) : null}
    </Box>
  )
}

export function GitPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const plan = useMemo(() => planFor(props), [props.toolUseConfirm.input])
  if (plan === null) return <FallbackPermissionRequest {...props} />
  return (
    <FallbackPermissionRequest
      {...props}
      title={plan.groups.length > 1 ? 'Git commits' : 'Git commit'}
      body={<GitPlanBody plan={plan} />}
    />
  )
}
