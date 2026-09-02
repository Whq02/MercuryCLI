import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { useModalOrTerminalSize } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js';
export function General() {
  // The shortcut grid picks its column count from the width it actually has:
  // the command-center shell's interior (border + padding take four columns
  // of the slot's width), not the bare terminal width.
  const term = useTerminalSize();
  const { columns } = useModalOrTerminalSize(term);
  let t0;
      t0 = <Box><Text>Mercury is a coding harness — it reads your codebase, edits with your consent, and runs commands, never leaving the terminal.</Text></Box>;
  let t1;
      t1 = <Box flexDirection="column" paddingY={1} gap={1}>{t0}<Box flexDirection="column"><Box><Text bold={true}>Shortcuts</Text></Box><PromptInputHelpMenu gap={2} fixedWidth={true} availableColumns={Math.max(20, columns - 4)} /></Box></Box>;
  return t1;
}
