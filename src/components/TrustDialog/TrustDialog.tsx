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

export function TrustDialog({ onDone }: Props): React.ReactNode {
  const alreadyTrusted = checkHasTrustDialogAccepted();
  const { rows } = useTerminalSize();
  const centred = useFirstRunCardsCentred();
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;
  const doneFiredRef = React.useRef(false);
  const exitingRef = React.useRef(false);

  const exit = (): void => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    gracefulShutdownSync(1, 'closed', {
      finalMessage: 'Setup stopped. Run mercury again to finish.',
    });
  };

  useTimer(() => {
    if (!alreadyTrusted || doneFiredRef.current) return;
    const handle = startTimeout(() => {
      if (doneFiredRef.current) return;
      doneFiredRef.current = true;
      onDoneRef.current();
    }, 0);
    return () => {
      stopTimeout(handle);
    };
  }, [alreadyTrusted]);

  const exitState = useExitOnCtrlCDWithKeybindings(exit, undefined, !alreadyTrusted);

  useKeybinding('confirm:no', exit, {
    context: 'Confirmation',
    isActive: !alreadyTrusted,
  });

  if (alreadyTrusted) {
    return null;
  }

  const tone = centred ? 'cardBrown' : 'warning';
  const shortFrame = rows < 18;
  const displayCwd = getFsImplementation().cwd();
  const normalizedDisplayCwd = normalizePathForConfigKey(displayCwd);
  const grantRoot = getProjectPathForConfig();
  const showsGrantRoot =
    !shortFrame && normalizePathForConfigKey(grantRoot) !== normalizedDisplayCwd;
  const isHomeDir =
    normalizePathForConfigKey(getCwd()) === normalizePathForConfigKey(homedir());

  return (
    <PermissionDialog title="Trust this folder?" color={tone} titleColor={tone}>
      <Box flexDirection="column" gap={shortFrame ? 0 : 1}>
        <Text bold>{displayCwd}</Text>
        {shortFrame ? (
          <Text>Mercury reads, edits and runs files here.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              Trust a folder only if you know what is in it: its settings can run hooks and helper commands, and its files can carry instructions for the model.
            </Text>
            <Text>Mercury reads, edits and runs files here.</Text>
          </Box>
        )}
        {showsGrantRoot && (
          <Text dimColor>
            Trust applies to the whole repository at <Text bold>{grantRoot}</Text>.
          </Text>
        )}
        <Select
          options={[
            { label: 'Yes, I trust this folder', value: 'yes' },
            { label: 'No, exit', value: 'no' },
          ]}
          scrollMovesFocus={false}
          onChange={value => {
            if (value === 'yes') {
              if (isHomeDir) {
                setSessionTrustAccepted(true);
              } else {
                saveCurrentProjectConfig(current => ({
                  ...current,
                  hasTrustDialogAccepted: true,
                }));
              }
              onDone();
            } else {
              exit();
            }
          }}
          onCancel={exit}
        />
        {exitState.pending && (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        )}
      </Box>
    </PermissionDialog>
  );
}
