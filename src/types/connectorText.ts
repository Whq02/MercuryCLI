// The connector_text wire-block model — a Mercury reconstruction of the
// provider wire shape, written from its usage sites (:
// LIVE — the old feature('CONNECTOR_TEXT') gates died with the R1c macro
// fold; streamCore, Message.tsx and logging consult these guards
// unconditionally, and a non-matching block simply returns false).
export type ConnectorTextBlock = {
  type: 'connector_text';
  text?: string;
  [key: string]: unknown;
};

// The streaming-delta counterpart, reconstructed from the claude.ts consumer
// (`delta.type === 'connector_text_delta'`, `contentBlock.connector_text +=
// delta.connector_text`). Same feature('CONNECTOR_TEXT')=false DCE gate.
export type ConnectorTextDelta = {
  type: 'connector_text_delta';
  connector_text: string;
  [key: string]: unknown;
};

export function isConnectorTextBlock(block: unknown): block is ConnectorTextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'connector_text'
  );
}
