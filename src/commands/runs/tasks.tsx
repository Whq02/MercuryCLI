import * as React from 'react';
import type { LocalJSXCommandContext } from '../catalogue/commands.js';
import { BackgroundTasksDialog } from '../../screen/tasks/BackgroundTasksDialog.js';
import type { LocalJSXCommandOnDone } from '../catalogue/command.js';
import { CommandPopupLease } from '../../screen/overlays/CommandPopupSlot.js';
import { claimCommandPopup } from '../../screen/cockpit/commandPopup.js';
import { crewDoorShape } from '../../screen/fullscreen-layout/CrewViewSlot.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args?: string): Promise<React.ReactNode> {
  const initialDetailTaskId = args?.trim() ? args.trim() : undefined;
  const token = claimCommandPopup({ ...crewDoorShape('runs'), compact: 'pane' });
  return <CommandPopupLease token={token}><BackgroundTasksDialog toolUseContext={context} onDone={onDone} initialDetailTaskId={initialDetailTaskId} /></CommandPopupLease>;
}
