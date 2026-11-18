import type { SessionListing } from '../../types/logs.js';
import type { Message } from '../../types/message.js';

export type PaintsRows = { addDisplayRow?: (row: Message) => void; transcriptFile?: () => string };
export type ResumableLog = Omit<Partial<SessionListing>, 'messages'> & { messages: Message[] };
