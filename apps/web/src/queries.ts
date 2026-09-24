import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from './api.js';
import { realtimeOnline } from './realtime.js';
import type {
  CannedResponse,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  Counts,
  FilterKey,
  Label,
  Me,
  Message,
} from './types.js';

/** Com o WebSocket no ar as consultas só revalidam a cada minuto (rede de segurança); sem ele, a cada poucos segundos. */
const POLL_OFFLINE = 4000;
const POLL_SAFETY_NET = 60_000;
const poll = () => (realtimeOnline() ? POLL_SAFETY_NET : POLL_OFFLINE);

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => get<Me>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });

export interface ListFilters {
  filter: FilterKey;
  search: string;
  unreadOnly?: boolean;
}

function listUrl(f: ListFilters): string {
  const q = new URLSearchParams({ limit: '100' });
  if (f.filter === 'unassigned') q.set('assignee', 'unassigned');
  if (f.filter === 'mine') q.set('assignee', 'me');
  if (f.filter !== 'all' || !f.search) q.set('status', 'open');
  if (f.search) q.set('search', f.search);
  if (f.unreadOnly) q.set('unread', 'true');
  return `/conversations?${q.toString()}`;
}

export const useConversations = (f: ListFilters) =>
  useQuery({
    queryKey: ['conversations', f],
    queryFn: () => get<{ items: ConversationSummary[]; nextCursor: string | null }>(listUrl(f)),
    refetchInterval: poll,
    placeholderData: keepPreviousData,
  });

export const useCounts = () =>
  useQuery({
    queryKey: ['counts'],
    queryFn: () => get<Counts>('/conversations/counts'),
    refetchInterval: poll,
  });

export const useConversation = (id: string | undefined) =>
  useQuery({
    queryKey: ['conversation', id],
    queryFn: () => get<ConversationDetail>(`/conversations/${id ?? ''}`),
    enabled: !!id,
    refetchInterval: poll,
    retry: false,
  });

export const useMessages = (id: string | undefined) =>
  useQuery({
    queryKey: ['messages', id],
    queryFn: () =>
      get<{ items: Message[]; nextCursor: string | null }>(
        `/conversations/${id ?? ''}/messages?limit=100`,
      ),
    enabled: !!id,
    refetchInterval: poll,
    retry: false,
  });

export const useCanned = () =>
  useQuery({
    queryKey: ['canned'],
    queryFn: () => get<{ items: CannedResponse[] }>('/canned-responses'),
    staleTime: 60_000,
  });

export const useLabels = () =>
  useQuery({
    queryKey: ['labels'],
    queryFn: () => get<{ items: Label[] }>('/labels'),
    staleTime: 60_000,
  });

function useRefreshAll() {
  const qc = useQueryClient();
  return (conversationId?: string) => {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['counts'] });
    if (conversationId) {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
    }
  };
}

/**
 * Envio com UI otimista: a mensagem aparece na hora com `queued` e o `client_message_id` gerado aqui. Se a
 * requisição cair e for repetida, o servidor devolve a mesma mensagem (idempotência): nunca duplica.
 */
export function useSendMessage(conversationId: string, me: Me | undefined) {
  const qc = useQueryClient();
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (v: {
      content: string;
      private: boolean;
      clientMessageId: string;
      attachments?: { id: string; name: string; size: number }[];
    }) =>
      post<{ message: Message }>(`/conversations/${conversationId}/messages`, {
        content: v.content,
        private: v.private,
        client_message_id: v.clientMessageId,
        ...(v.attachments?.length ? { attachment_ids: v.attachments.map((a) => a.id) } : {}),
      }),
    onMutate: (v) => {
      const key = ['messages', conversationId];
      const optimistic: Message = {
        id: `tmp-${v.clientMessageId}`,
        conversationId,
        direction: 'out',
        senderType: 'user',
        senderId: me?.user.id ?? null,
        content: v.content,
        private: v.private,
        replyToId: null,
        status: 'queued',
        clientMessageId: v.clientMessageId,
        attachments: (v.attachments ?? []).map((a) => ({
          id: a.id,
          fileName: a.name,
          contentType: null,
          size: a.size,
          status: 'clean' as const,
        })),
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData<{ items: Message[]; nextCursor: string | null }>(key, (old) => ({
        items: [optimistic, ...(old?.items ?? [])],
        nextCursor: old?.nextCursor ?? null,
      }));
    },
    onSettled: () => {
      refresh(conversationId);
    },
  });
}

export function useUpdateConversation(conversationId: string) {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (v: { status?: ConversationStatus; assignee_id?: string | null }) =>
      patch<ConversationDetail>(`/conversations/${conversationId}`, v),
    onSuccess: () => {
      refresh(conversationId);
    },
  });
}

export function useMarkRead() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (id: string) => post(`/conversations/${id}/read`),
    onSuccess: (_d, id) => {
      refresh(id);
    },
  });
}

export function useToggleLabel(conversationId: string) {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: async (v: { labelId: string; on: boolean }) => {
      const path = `/conversations/${conversationId}/labels/${v.labelId}`;
      await (v.on ? post(path) : del(path));
    },
    onSuccess: () => {
      refresh(conversationId);
    },
  });
}
