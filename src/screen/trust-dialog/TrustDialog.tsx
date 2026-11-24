import { homedir } from 'os';
import { resolve } from 'path';
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js';
import { exitChordNoticeText } from '../composer/ExitChordNotice.js'
import React from 'react';
import { useTimer } from '../effects/effects.js';
import { useExitChord } from '../keys/useExitChord.js';
import { Box, Text } from '../themedRenderer.js';
import { useKeybinding } from '../keys/useKeybinding.js';
import { checkHasTrustDialogAccepted, getProjectPathForConfig, saveCurrentProjectConfig, setPathTrusted } from '../../platform/settings/config.js';
import { getCwd } from '../../platform/files/cwd.js';
import { getFsImplementation } from '../../platform/files/fsOperations.js';
import { gracefulShutdownSync } from '../../platform/processes/gracefulShutdown.js';
import { normalizePathForConfigKey } from '../../platform/files/path.js';
import { Select } from '../select/index.js';
import { PermissionDialog } from '../../permissions/cards/PermissionDialog.js';
import { useFirstRunCardsCentred } from '../../boot/first-run/MercurySetupFrame.js';
import { startTimeout, stopTimeout } from '../../platform/async/timers.js';

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

  const exitState = useExitChord(exit);

  useKeybinding('confirm:no', exit, { context: 'Confirmation' });

  if (alreadyTrusted) {
    return null;
  }

  const choose = (choice: TrustChoice): void => {
    if (choice === 'exit') {
      exit();
      return;
    }
    if (normalizePathForConfigKey(resolve(getCwd())) === normalizePathForConfigKey(homedir())) {
      setPathTrusted(getCwd());
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
