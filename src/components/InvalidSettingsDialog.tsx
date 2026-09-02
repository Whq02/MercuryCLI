import React from 'react';
import { Text } from '../ink.js';
import type { ValidationError } from '../utils/settings/validation.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { ValidationErrorsList } from './ValidationErrorsList.js';

type Props = {
  settingsErrors: ValidationError[];
  onContinue: () => void;
  onExit: () => void;
  onFix?: () => void;
};

function isHardError(error: ValidationError): boolean {
  if (error.severity === 'warning') return false;
  return error.mcpErrorMetadata?.severity !== 'warning';
}

export function InvalidSettingsDialog({
  settingsErrors,
  onContinue,
  onExit,
  onFix,
}: Props): React.ReactNode {
  const [inputArmed, setInputArmed] = React.useState(false);
  React.useEffect(() => {
    const timer = setTimeout(() => setInputArmed(true), 350);
    return () => clearTimeout(timer);
  }, []);
  function handleSelect(value: 'exit' | 'fix' | 'continue'): void {
    if (!inputArmed) return;
    if (value === 'exit') {
      onExit();
    } else if (value === 'fix') {
      onFix?.();
    } else {
      onContinue();
    }
  }

  const hasHardErrors = settingsErrors.some(isHardError);

  const continueOption = {
    label: 'Continue without these settings',
    value: 'continue' as const,
  };
  const fixOption = { label: 'Fix with Mercury', value: 'fix' as const };
  const exitOption = { label: 'Exit and fix manually', value: 'exit' as const };

  const options: Array<{ label: string; value: 'exit' | 'fix' | 'continue' }> =
    hasHardErrors
      ? [...(onFix ? [fixOption] : []), exitOption, continueOption]
      : [continueOption, ...(onFix ? [fixOption] : []), exitOption];

  const title = hasHardErrors ? 'Settings Error' : 'Settings Warning';
  const rawOnCancel = hasHardErrors ? onExit : onContinue;
  const onCancel = (): void => {
    if (inputArmed) rawOnCancel();
  };

  const footerText = hasHardErrors
    ? 'Files with errors are skipped entirely, not just the invalid settings.'
    : 'The values listed above were skipped; the rest of the file is in effect.';

  return (
    <Dialog title={title} onCancel={onCancel} color="warning">
      <ValidationErrorsList errors={settingsErrors} />
      <Text dimColor={true}>{footerText}</Text>
      <Select options={options} onChange={handleSelect} />
    </Dialog>
  );
}
