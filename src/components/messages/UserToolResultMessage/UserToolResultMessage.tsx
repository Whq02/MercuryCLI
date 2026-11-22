;
import type { ToolResultBlockParam } from '../../../types/wire.js'
import * as React from 'react';
import type { Tools } from '../../../Tool.js';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js';
import { type buildMessageLookups, CANCEL_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, REJECT_MESSAGE } from '../../../services/messages.js';
import type { HermesKillInfo } from '../../../utils/permissions/capabilityGate.js';
import { UserToolCanceledMessage } from './UserToolCanceledMessage.js';
import { UserToolErrorMessage } from './UserToolErrorMessage.js';
import { UserToolRejectMessage } from './UserToolRejectMessage.js';
import { UserToolSuccessMessage } from './UserToolSuccessMessage.js';
import { useGetToolFromMessages } from './utils.js';
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'
type Props = Unbuilt;
export function UserToolResultMessage(arg0: Props): React.ReactNode {
  return notBuilt('src/components/messages/UserToolResultMessage/UserToolResultMessage.tsx:24')
}
