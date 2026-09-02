import { createContext } from 'react';
export type TerminalSize = {
  columns: number;
  rows: number;
};
export const TerminalSizeContext = createContext<TerminalSize | null>(null);
export const LiveTerminalSizeContext = createContext<TerminalSize | null>(null);
