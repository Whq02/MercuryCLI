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
  // Hand the broken settings file to Mercury to repair. When omitted, the
  // "Fix with Mercury" option is simply not offered.
  onFix?: () => void;
};

// Two severity channels fold here: the loader-level `severity` field (B9 —
// the salvage/filter roads grade their value-level skips 'warning') and the
// MCP metadata severity. An error neither channel grades 'warning' counts
// as hard; only explicit warnings stay soft.
function isHardError(error: ValidationError): boolean {
  if (error.severity === 'warning') return false;
  return error.mcpErrorMetadata?.severity !== 'warning';
}

/**
 * Shown when settings files fail validation.
 *
 * The dialog adapts to the worst severity present: any hard error makes it an
 * ERROR dialog ("Settings Error" — whole files are skipped, esc exits);
 * warnings alone make it a WARNING dialog ("Settings Warning" — only the
 * listed values are skipped, esc continues). The user can continue without
 * the bad settings, hand the file to Mercury to fix, or exit and repair it
 * by hand.
 */
export function InvalidSettingsDialog({
  settingsErrors,
  onContinue,
  onExit,
  onFix,
}: Props): React.ReactNode {
  // THE SETTLE BEAT (the stacked-gate fall-through class): this gate mounts
  // directly under the trust card in the boot order, and a taught
  // digit-then-Enter answered the trust card with the digit while the Enter
  // landed HERE ~360ms later, committing this gate's focused default with
  // nothing painted long enough to read. Input arms after one short beat;
  // the frame paints immediately either way.
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

  // Ordering states the recommendation: hard errors lead with recovery
  // (fix/exit); warnings lead with the non-destructive continue.
  const options: Array<{ label: string; value: 'exit' | 'fix' | 'continue' }> =
    hasHardErrors
      ? [...(onFix ? [fixOption] : []), exitOption, continueOption]
      : [continueOption, ...(onFix ? [fixOption] : []), exitOption];

  const title = hasHardErrors ? 'Settings Error' : 'Settings Warning';
  // esc lands on the safe action for the severity: exit on hard errors,
  // continue on warnings.
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
