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
