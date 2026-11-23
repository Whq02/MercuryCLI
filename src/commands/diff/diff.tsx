import type { LocalJSXCommandCall } from '../catalogue/command.js';
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const {
    DiffDialog
  } = await import('../../screen/diff/DiffDialog.js');
  const initialPath = args.trim() || undefined;
  return <DiffDialog messages={context.messages} onDone={onDone} initialPath={initialPath} />;
};
