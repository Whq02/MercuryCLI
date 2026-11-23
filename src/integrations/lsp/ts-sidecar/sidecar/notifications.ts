import { fromUri } from './lsp.js'
import type { RequireState } from './needs.js'

export function handleNotification(
  method: string,
  params: unknown,
  requireState: RequireState,
  schedulePublish: (file: string) => void,
  finish: (code: number) => void,
  shutdownRequested: boolean,
): void {
  switch (method) {
    case 'initialized':
      return
    case 'exit':
      finish(shutdownRequested ? 0 : 1)
      return
    case 'textDocument/didOpen': {
      const st = requireState()
      const p = params as {
        textDocument: { uri: string; text: string }
      }
      const file = st.normalize(fromUri(p.textDocument.uri))
      st.openDoc(file, p.textDocument.text)
      schedulePublish(file)
      return
    }
    case 'textDocument/didChange': {
      const st = requireState()
      const p = params as {
        textDocument: { uri: string }
        contentChanges: { text: string }[]
      }
      const file = st.normalize(fromUri(p.textDocument.uri))
      const last = p.contentChanges[p.contentChanges.length - 1]
      if (last) st.changeDoc(file, last.text)
      schedulePublish(file)
      return
    }
    case 'textDocument/didSave': {
      const st = requireState()
      const p = params as { textDocument: { uri: string } }
      const file = st.normalize(fromUri(p.textDocument.uri))
      st.closeDoc(file)
      schedulePublish(file)
      return
    }
    case 'textDocument/didClose': {
      const st = requireState()
      const p = params as { textDocument: { uri: string } }
      st.closeDoc(st.normalize(fromUri(p.textDocument.uri)))
      return
    }
    case 'workspace/didRenameFiles': {
      const st = requireState()
      const p = params as { files?: { oldUri: string }[] }
      for (const f of p.files ?? []) {
        st.closeDoc(st.normalize(fromUri(f.oldUri)))
      }
      return
    }
    default:
      return
  }
}
