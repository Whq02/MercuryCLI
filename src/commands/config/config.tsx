import * as React from 'react';
import { Settings, nextSettingsOpen } from '../../components/Settings/Settings.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings openToken={nextSettingsOpen()} onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} context={context} defaultTab="Config" />;
};
