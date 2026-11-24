type SourceLicence = { project: string; version: string; file: string; copyright: ReadonlyArray<string>; text: string }

const PI_LICENCE: SourceLicence = {
  project: 'Pi',
  version: 'v1.6.0',
  file: 'LICENSE',
  copyright: ['Copyright (c) 2025 Mario Zechner'],
  text: `MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
}

const INK_LICENCE: SourceLicence = {
  project: 'Ink',
  version: 'v8.0.0',
  file: 'license',
  copyright: ['Copyright (c) Vadym Demedes <vadimdemedes@hey.com> (https://github.com/vadimdemedes)', 'Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)'],
  text: `MIT License

Copyright (c) Vadym Demedes <vadimdemedes@hey.com> (https://github.com/vadimdemedes)
Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
}

export const SOURCE_LICENCES: ReadonlyArray<SourceLicence> = [PI_LICENCE, INK_LICENCE]

export function sourceAttributionLines(): string[] {
  return [
    '- Parts of the agent runtime (the turn loop in `src/engine/loop/` and `src/engine/tool-dispatch/`, and the undo history of the typing box in `src/screen/composer/useInputUndo.ts`) derive from **Pi**, ' + PI_LICENCE.copyright.join(' and ') + ', MIT (https://github.com/earendil-works/pi), forked at v1.6.0 (`faac5858`) and changed by Mercury; the changes are listed in `src/engine/loop/DIVERGENCE.tsv`.',
    '',
    '- Parts of the terminal runtime (`src/screen/renderer/` — reconciler, DOM, styles, component shells) derive from the **Ink** project — ' + INK_LICENCE.copyright.join(' and ') + ', MIT (https://github.com/vadimdemedes/ink); the parts written again are re-derived from v8.0.0 (`26d2c3f8`). The layout engine, termio tokenizer, input byte layer and frame writer are Mercury-native.',
    '',
    '- The extensions estate: archive sources are decompressed with **fflate** (MIT; a direct dependency) through the hardened reader at `src/platform/archive/zip.ts`; the extensions estate reads no bundle files — an extension declares its servers in its own manifest.',
    ...SOURCE_LICENCES.flatMap(licence => ['', `### ${licence.project} ${licence.version} — ${licence.file}`, '', '```text', licence.text, '```']),
  ]
}
