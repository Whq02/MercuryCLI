import React from 'react';
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
  isStandaloneDialog,
  externalIncludes,
}: Props) {
  const handleSelection = (value: 'yes' | 'no') => {
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
      onCancel={() => handleSelection('no')}
      hideBorder={!isStandaloneDialog}
      hideInputGuide={!isStandaloneDialog}
    >
      <Text>
        This project's MERCURY.md imports files outside the current working
        directory. Never allow this for third-party repositories.
      </Text>
      {externalIncludes && externalIncludes.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor={true}>External imports:</Text>
          {externalIncludes.map((include: ExternalInstructionInclude, i: number) => (
            <Text key={i} dimColor={true}>
              {'  '}
              {include.path}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor={true}>
        Important: Only use Mercury with files you trust. Accessing untrusted
        files may pose security risks.
      </Text>
      <Select
        options={[
          { label: 'Yes, allow external imports', value: 'yes' },
          { label: 'No, disable external imports', value: 'no' },
        ]}
        onChange={(value: string) => handleSelection(value as 'yes' | 'no')}
      />
      {
}
      <Text dimColor={true}>
        ↑↓ choose · ↵ answers · esc answers No — the answer is saved for this
        project
      </Text>
    </Dialog>
  );
}
