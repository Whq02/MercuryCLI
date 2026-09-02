

declare module 'color-diff-napi' {
  export type SyntaxTheme = any;
  export const ColorDiff: any;
  export const ColorFile: any;
  export const getSyntaxTheme: any;
}

declare module 'vscode-jsonrpc/node.js' {
  export type MessageConnection = any;
  export const createMessageConnection: any;
  export const StreamMessageReader: any;
  export const StreamMessageWriter: any;
  export const Trace: any;
}

declare module 'src/tasks/MonitorMcpTask/MonitorMcpTask.js' {
  export type MonitorMcpTaskState = any;
}


declare module 'image-processor-napi' { const m: any; export = m; }
declare module 'url-handler-napi' { const m: any; export = m; }
declare module 'cli-highlight' {
  export const highlight: any;
  export const supportsLanguage: any;
}
declare module 'plist' { const m: any; export = m; }
declare module 'cacache' { const m: any; export = m; }
declare module 'bun:ffi' { const m: any; export = m; }
