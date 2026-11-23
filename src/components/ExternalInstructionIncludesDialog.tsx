import * as React from 'react';
import { Box, Text } from '../ink.js';
import type { ExternalInstructionInclude } from '../services/instructions/engine.js';
import { saveCurrentProjectConfig } from '../utils/config.js';
import type { ProjectConfig } from '../utils/config.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';

type Props = {
  onDone(): void;
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalInstructionInclude[];
};

export function ExternalInstructionIncludesDialog({
  onDone,
  isStandaloneDialog = true,
  externalIncludes,
}: Props): React.ReactNode {
  const handleChoice = (value: 'yes' | 'no'): void => {
    saveCurrentProjectConfig((current: ProjectConfig) => ({
      ...current,
      hasExternalIncludesApproved: value === 'yes',
      hasExternalIncludesWarningShown: true,
    }));
    onDone();
  };

  return (
    <Dialog
      title="Allow external instruction file imports?"
      color="warning"
      hideBorder={!isStandaloneDialog}
      hideInputGuide={!isStandaloneDialog}
      onCancel={() => handleChoice('no')}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          This project&apos;s MERCURY.md imports files outside the current working directory. Never
          allow this for third-party repositories.
        </Text>
        {externalIncludes && externalIncludes.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>External imports:</Text>
            <Box flexDirection="column" paddingLeft={2}>
              {externalIncludes.map((item, index) => (
                <Text key={`${item.path}-${index}`} dimColor>
                  {item.path}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
        <Text>
          Important: Only use Mercury with files you trust. Accessing untrusted files may pose
          security risks.
        </Text>
        <Select
          options={[
            { label: 'Yes, allow external imports', value: 'yes' as const },
            { label: 'No, disable external imports', value: 'no' as const },
          ]}
          onChange={handleChoice}
          onCancel={() => handleChoice('no')}
        />
        <Text dimColor>
          ↑↓ choose · ↵ answers · esc answers No — the answer is saved for this project
        </Text>
      </Box>
    </Dialog>
  );
}
