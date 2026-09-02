import { createContext } from 'react';
export type TerminalSize = {
  columns: number;
  rows: number;
};
/** The size a component lays out in. Layout owners re-provide it narrowed
 *  (a centre column, a capsule) and the viewport floor's hosts re-provide
 *  it FROZEN at the last size that fit while the window is under the floor. */
export const TerminalSizeContext = createContext<TerminalSize | null>(null);
/** The window's TRUE size, provided by the app root beside the size above
 *  and never re-provided: the hosts that decide the viewport floor read it,
 *  so a frozen surface size above them can never hide the window they
 *  must judge. */
export const LiveTerminalSizeContext = createContext<TerminalSize | null>(null);
