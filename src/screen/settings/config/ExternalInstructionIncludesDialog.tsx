import * as React from 'react';
import { Box, Text } from '../../themedRenderer.js';
import type { ExternalInstructionInclude } from '../../../sessions/instructions/instructionFiles.js';
import { saveCurrentProjectConfig } from '../../../platform/settings/config.js';
import type { ProjectConfig } from '../../../platform/settings/config.js';
import { Select } from '../../select/index.js';
import { Dialog } from '../../theme/Dialog.js';

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
      onCancel={() => handleChoice('no')}
      hideBorder={!isStandaloneDialog}
      hideInputGuide={!isStandaloneDialog}
    >
      <Text>
        This project's MERCURY.md imports files outside the current working
        directory. Never allow this for third-party repositories.
      </Text>
      {externalIncludes && externalIncludes.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>External imports:</Text>
          {externalIncludes.map((item, index) => (
            <Text key={`${item.path}-${index}`} dimColor>
              {`  ${item.path}`}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>
        Important: Only use Mercury with files you trust. Accessing untrusted
        files may pose security risks.
      </Text>
      <Select
        options={[
          { label: 'Yes, allow external imports', value: 'yes' as const },
          { label: 'No, disable external imports', value: 'no' as const },
        ]}
        onChange={handleChoice}
      />
      <Text dimColor>
        ↑↓ choose · ↵ answers · esc answers No — the answer is saved for this
        project
      </Text>
    </Dialog>
  );
}
