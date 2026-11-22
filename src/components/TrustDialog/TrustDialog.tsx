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
import { notBuilt } from '../../pi/holes.js'
type Props = {
  onDone(): void;
};

export function TrustDialog(arg0: Props): React.ReactNode {
  return notBuilt('src/components/TrustDialog/TrustDialog.tsx:23')
}
