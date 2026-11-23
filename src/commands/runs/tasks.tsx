import * as React from 'react';
import type { LocalJSXCommandContext } from '../catalogue/commands.js';
import { BackgroundTasksDialog } from '../../screen/tasks/BackgroundTasksDialog.js';
import type { LocalJSXCommandOnDone } from '../catalogue/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args?: string): Promise<React.ReactNode> {
  const initialDetailTaskId = args?.trim() ? args.trim() : undefined;
  return <BackgroundTasksDialog toolUseContext={context} onDone={onDone} initialDetailTaskId={initialDetailTaskId} />;
}
