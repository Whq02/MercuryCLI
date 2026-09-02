import figures from 'figures';
import * as React from 'react';
import { Box, Text } from 'src/ink.js';

export function PromptInputStashNotice({ hasStash }: { hasStash: boolean }) {
  if (!hasStash) return null;
  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        {figures.pointerSmall} Stashed (auto-restores after submit)
      </Text>
    </Box>
  );
}
