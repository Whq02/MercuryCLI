import type { SessionListing } from '../../sessions/transcripts/transcriptEntries.js';
import type { Message } from '../../engine/message-shapes/message.js';

export type ResumableListing = Omit<Partial<SessionListing>, 'messages'> & { messages: Message[] };
