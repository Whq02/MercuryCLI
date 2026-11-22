import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '../ink.js';
import { count } from '../utils/array.js';
import { MessageResponse } from './MessageResponse.js';
import { ToolCardMarker, toolCardCountColor } from './mercury-ui/toolCardMeta.js';
import { StructuredDiffList } from './StructuredDiffList.js';
import { isSqliteRowTarget } from '../tools/FileWriteTool/structuredTargets.js';
import { basename } from 'node:path';
import { notBuilt, type Unbuilt } from '../pi/holes.js'
type Props = Unbuilt;
export function FileEditToolUpdatedMessage(arg0: Props): React.ReactNode {
  return notBuilt('src/components/FileEditToolUpdatedMessage.tsx:19')
}
