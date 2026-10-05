import stripAnsi from 'strip-ansi'

export function expandTabs(value: string): string {
  return value.includes('\t') ? value.replaceAll('\t', '    ') : value
}

export function stripControls(value: string): string {
  // eslint-disable-next-line no-control-regex -- the control filter is the point
  return stripAnsi(value.replace(/[\u0080-\u009f]/g, '')).replace(
    // eslint-disable-next-line no-control-regex -- the control filter is the point
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    '',
  )
}

export const __stripControlsForTest = stripControls
