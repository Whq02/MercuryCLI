import { homedir } from 'os';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import React from 'react';
import { setSessionTrustAccepted } from '../../bootstrap/state.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { checkHasTrustDialogAccepted, getProjectPathForConfig, saveCurrentProjectConfig } from '../../utils/config.js';
import { getCwd } from '../../utils/cwd.js';
import { getFsImplementation } from '../../utils/fsOperations.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { normalizePathForConfigKey } from '../../utils/path.js';
import { Select } from '../CustomSelect/index.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
import { useFirstRunCardsCentred } from '../MercurySetupFrame.js';
type Props = {
  onDone(): void;
};

export function TrustDialog({ onDone }: Props): React.ReactNode {
  const { rows } = useTerminalSize();
  const boxTone = useFirstRunCardsCentred() ? 'cardBrown' : 'warning';
  const hasTrustDialogAccepted = checkHasTrustDialogAccepted();
  React.useEffect(() => {
    if (!hasTrustDialogAccepted) return;
    const timer = setTimeout(onDone);
    return () => clearTimeout(timer);
  }, [hasTrustDialogAccepted, onDone]);

  function exit(): void {
    gracefulShutdownSync(1, 'closed', { finalMessage: 'Setup stopped. Run mercury again to finish.' });
  }

  function onChange(value: 'enable_all' | 'exit'): void {
    if (value === "exit") {
      exit();
      return;
    }
    const isHomeDir = homedir() === getCwd();
    if (isHomeDir) {
      setSessionTrustAccepted(true);
    } else {
      saveCurrentProjectConfig(current => ({
        ...current,
        hasTrustDialogAccepted: true,
      }));
    }
    onDone();
  }

  const exitState = useExitOnCtrlCDWithKeybindings(() => exit());
  useKeybinding("confirm:no", () => {
    exit();
  }, { context: "Confirmation" });

  if (hasTrustDialogAccepted) return null;

  const shortFrame = rows < 18;
  return (
    <PermissionDialog color={boxTone} titleColor={boxTone} title="Trust this folder?">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold={true}>{getFsImplementation().cwd()}</Text>
        {shortFrame ? (
          <Text>Mercury reads, edits and runs files here.</Text>
        ) : (
        <Text>Trust a folder only if you know what is in it: its settings can run hooks and helper commands, and its files can carry instructions for the model.</Text>
        )}
        {}
        {shortFrame ? null : <Text>Mercury reads, edits and runs files here.</Text>}
        {}
        {(() => {
          if (shortFrame) return null;
          const grantRoot = getProjectPathForConfig();
          if (grantRoot === normalizePathForConfigKey(getFsImplementation().cwd())) return null;
          return (
            <Text>
              This folder is inside a repository — trusting it covers the whole repository at{' '}
              <Text bold={true}>{grantRoot}</Text>, including its other folders and worktrees.
            </Text>
          );
        })()}
        <Select options={[{ label: "Yes, I trust this folder", value: "enable_all" }, { label: "No, exit", value: "exit" }]} onChange={(value: string) => onChange(value as 'enable_all' | 'exit')} onCancel={() => onChange("exit")} />
        {exitState.pending ? <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text> : null}
      </Box>
    </PermissionDialog>
  );
}
