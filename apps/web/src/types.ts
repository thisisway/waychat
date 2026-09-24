export type ConversationStatus = 'open' | 'pending' | 'snoozed' | 'resolved';

export interface Me {
  user: { id: string; name: string; email: string; locale: string };
  account: { id: string; name: string; slug: string; require2fa: boolean };
  role: { id: string; name: string };
  permissions: string[];
}

export interface ConversationSummary {
  id: string;
  displayId: number;
  inboxId: string;
  status: ConversationStatus;
  priority: string;
  assigneeId: string | null;
  contact: { id: string; name: string; phone: string | null; email: string | null };
  lastMessage: string | null;
  lastActivityAt: string;
  unreadCount: number;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface ConversationDetail extends ConversationSummary {
  snoozedUntil: string | null;
  resolvedAt: string | null;
  createdAt: string;
  inbox: { id: string; name: string; channelType: string };
  labels: Label[];
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  senderType: 'contact' | 'user' | 'bot' | 'system';
  senderId: string | null;
  content: string | null;
  private: boolean;
  replyToId: string | null;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  clientMessageId: string | null;
  createdAt: string;
}

export interface Counts {
  all: number;
  unassigned: number;
  mine: number;
  unread: number;
}

export interface CannedResponse {
  id: string;
  shortcut: string;
  content: string;
}

export type FilterKey = 'unassigned' | 'mine' | 'all';
