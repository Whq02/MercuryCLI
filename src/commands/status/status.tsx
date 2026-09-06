import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { Settings, nextSettingsOpen } from '../../components/Settings/Settings.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <Settings openToken={nextSettingsOpen()} onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} context={context} defaultTab="Status" />;
}
