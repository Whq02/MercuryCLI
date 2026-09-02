import figures from 'figures';
import * as React from 'react';
import { Box, Text } from 'src/ink.js';

// The one-line reminder under the prompt while a draft sits in the stash.
// It renders only between stash and submit; the restore is automatic, and
// the copy says so — the user never has to go fetch anything.
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
