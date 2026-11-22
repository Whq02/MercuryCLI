import * as React from 'react'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { useState } from 'react'
import { Box, Text } from 'src/ink.js'
import { formatAPIError } from 'src/services/api/errorUtils.js'
import { apiTimeoutMsOverride } from 'src/utils/envValidation.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { useInterval } from 'usehooks-ts'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { GLYPH } from '../../utils/glyphs.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type Props = Unbuilt

export function SystemAPIErrorMessage(arg0: Props): React.ReactNode {
  return notBuilt('src/components/messages/SystemAPIErrorMessage.tsx:20')
}
