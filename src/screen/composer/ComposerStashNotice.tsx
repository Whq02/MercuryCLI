import figures from 'figures';
import { Box, Text } from 'src/screen/themedRenderer.js';

export function ComposerStashNotice({ hasStash }: { hasStash: boolean }) {
  if (!hasStash) return null;
  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        {figures.pointerSmall} Stashed (auto-restores after submit)
      </Text>
    </Box>
  );
}
