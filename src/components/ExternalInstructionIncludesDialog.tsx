import { Box, Text } from '../ink.js';
import type { ExternalInstructionInclude } from '../services/instructions/engine.js';
import { saveCurrentProjectConfig } from '../utils/config.js';
import type { ProjectConfig } from '../utils/config.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type Props = {
  onDone(): void;
  isStandaloneDialog?: boolean;
  externalIncludes?: ExternalInstructionInclude[];
};

export function ExternalInstructionIncludesDialog(arg0: Props): Unbuilt {
  return notBuilt('src/components/ExternalInstructionIncludesDialog.tsx:14')
}
