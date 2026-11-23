import { homedir } from 'os';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import React from 'react';
import { useTimer } from '../../hooks/effects.js';
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
import { startTimeout, stopTimeout } from '../../utils/timers.js';

type Props = {
  onDone(): void;
};

type TrustChoice = 'enable_all' | 'exit';

function exit(): void {
  gracefulShutdownSync(1, 'closed', {
    finalMessage: 'Setup stopped. Run mercury again to finish.',
  });
}

export function TrustDialog({ onDone }: Props): React.ReactNode {
  const { rows } = useTerminalSize();
  const tone = useFirstRunCardsCentred() ? 'cardBrown' : 'warning';
  const alreadyTrusted = checkHasTrustDialogAccepted();

  useTimer(() => {
    if (!alreadyTrusted) return;
    const handle = startTimeout(onDone, 0);
    return () => {
      stopTimeout(handle);
    };
  }, [alreadyTrusted, onDone]);

  const exitState = useExitOnCtrlCDWithKeybindings(exit);

  useKeybinding('confirm:no', exit, { context: 'Confirmation' });

  if (alreadyTrusted) {
    return null;
  }

  const choose = (choice: TrustChoice): void => {
    if (choice === 'exit') {
      exit();
      return;
    }
    if (homedir() === getCwd()) {
      setSessionTrustAccepted(true);
    } else {
      saveCurrentProjectConfig(current => ({
        ...current,
        hasTrustDialogAccepted: true,
      }));
    }
    onDone();
  };

  const shortFrame = rows < 18;
  const folder = getFsImplementation().cwd();
  const grantRoot = getProjectPathForConfig();
  const showsRepositoryNote = !shortFrame && grantRoot !== normalizePathForConfigKey(folder);

  return (
    <PermissionDialog title="Trust this folder?" color={tone} titleColor={tone}>
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{folder}</Text>
        {shortFrame ? (
          <Text>Mercury reads, edits and runs files here.</Text>
        ) : (
          <Text>
            Trust a folder only if you know what is in it: its settings can run hooks and helper commands, and its files can carry instructions for the model.
          </Text>
        )}
        {shortFrame ? null : <Text>Mercury reads, edits and runs files here.</Text>}
        {showsRepositoryNote ? (
          <Text>
            This folder is inside a repository — trusting it covers the whole repository at <Text bold>{grantRoot}</Text>, including its other folders and worktrees.
          </Text>
        ) : null}
        <Select
          options={[
            { label: 'Yes, I trust this folder', value: 'enable_all' },
            { label: 'No, exit', value: 'exit' },
          ]}
          onChange={choose}
          onCancel={() => choose('exit')}
          scrollMovesFocus={false}
        />
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : null}
      </Box>
    </PermissionDialog>
  );
}
