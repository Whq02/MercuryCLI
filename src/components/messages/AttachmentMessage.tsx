import React from 'react'
import { Box, Text } from '../../ink.js'
import type { Attachment } from '../../utils/attachments/types.js'
import { formatFileSize } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js'
import { MessageResponse } from '../MessageResponse.js'
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js'
import { UserImageMessage } from './UserImageMessage.js'
import { UserTextMessage } from './UserTextMessage.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { notBuilt } from '../../pi/holes.js'

function AttachmentLine({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor wrap="wrap">
        {children}
      </Text>
    </MessageResponse>
  )
}

function HookOutputBlock({
  output,
  hookName,
  hookEvent,
  verbose,
}: {
  output: string
  hookName: string
  hookEvent: string
  verbose: boolean
}): React.ReactNode {
  const lines = output.split('\n').filter(line => line !== '')
  return (
    <Box flexDirection="column">
      {lines.length === 0 ? (
        <AttachmentLine>Hook output is in the debug log.</AttachmentLine>
      ) : verbose ? (
        lines.map((line, index) => (
          <Text key={index} dimColor>
            {line}
          </Text>
        ))
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{lines[0]}</Text>
          {lines.length > 1 ? (
            <Text dimColor>
              … +{lines.length - 1} {plural(lines.length - 1, 'line')}{' '}
              <CtrlOToExpand />
            </Text>
          ) : null}
        </Box>
      )}
      <AttachmentLine>
        hook {hookName} · {hookEvent} · /hooks
      </AttachmentLine>
    </Box>
  )
}

export function AttachmentMessage(arg0: {
  addMargin?: boolean
  attachment: Attachment
  verbose?: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  return notBuilt('src/components/messages/AttachmentMessage.tsx:70')
}

export default AttachmentMessage
