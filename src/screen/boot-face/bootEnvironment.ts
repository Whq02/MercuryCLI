import { basename } from 'node:path';
import type { useEngineModel } from '../model-picker/useEngineModel.js';
import { renderModelChip } from '../../models/catalogue/engineModel.js';
import { getSessionAccent, getSessionCritterKey } from '../widgets/sessionAccent.js';

export function bootEnvironment(mainModel: ReturnType<typeof useEngineModel>, dir: string, dirTail = '') {
  const critterKey = getSessionCritterKey();
  return {
    model: renderModelChip(mainModel),
    critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
    critterHue: getSessionAccent().accent,
    dirBase: basename(dir) || dir,
    dirTail,
  };
}
