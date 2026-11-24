import type { LocalJSXCommandCall } from '../catalogue/command.js';
import { CommandPopupLease } from '../../screen/overlays/CommandPopupSlot.js';
import { claimCommandPopup } from '../../screen/cockpit/commandPopup.js';
import { CREW_POPUP_WIDE, crewDoorShape } from '../../screen/fullscreen-layout/CrewViewSlot.js';
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const {
    DiffDialog
  } = await import('../../screen/diff/DiffDialog.js');
  const initialPath = args.trim() || undefined;
  const token = claimCommandPopup(crewDoorShape('diff', CREW_POPUP_WIDE));
  return <CommandPopupLease token={token}><DiffDialog messages={context.messages} onDone={onDone} initialPath={initialPath} /></CommandPopupLease>;
};
