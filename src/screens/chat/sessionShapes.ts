import type { SessionListing } from '../../types/logs.js';
import type { Message } from '../../types/message.js';

export type ResumableLog = Omit<Partial<SessionListing>, 'messages'> & { messages: Message[] };
