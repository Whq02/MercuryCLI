import * as React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const {
    DiffDialog
  } = await import('../../components/diff/DiffDialog.js');
  const initialPath = args.trim() || undefined;
  return <DiffDialog messages={context.messages} onDone={onDone} initialPath={initialPath} />;
};
