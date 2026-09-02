import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { BackgroundTasksDialog } from '../../components/tasks/BackgroundTasksDialog.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args?: string): Promise<React.ReactNode> {
  // `/tasks <taskId>` drills straight into that task's
  // detail card — the cockpit RUNS lane routes each row here so ↵/click on a
  // specific process opens ITS card, not the list. Bare `/tasks` unchanged.
  const initialDetailTaskId = args?.trim() ? args.trim() : undefined;
  return <BackgroundTasksDialog toolUseContext={context} onDone={onDone} initialDetailTaskId={initialDetailTaskId} />;
}
