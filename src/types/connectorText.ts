export type ConnectorTextBlock = {
  type: 'connector_text';
  text?: string;
  [key: string]: unknown;
};

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
