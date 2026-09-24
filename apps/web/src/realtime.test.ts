import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { applyEvent } from './realtime.js';

const spyOn = () => {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
  const keys = () => spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
  return { qc, keys };
};

describe('applyEvent', () => {
  it('message.* invalida lista, contagens, conversa e mensagens da conversa', () => {
    const { qc, keys } = spyOn();
    applyEvent(qc, { type: 'message.created', payload: { conversation_id: 'c1' } });
    expect(keys()).toEqual([
      ['conversations'],
      ['counts'],
      ['conversation', 'c1'],
      ['messages', 'c1'],
    ]);
  });

  it('conversation.* não recarrega mensagens', () => {
    const { qc, keys } = spyOn();
    applyEvent(qc, { type: 'conversation.updated', payload: { conversation_id: 'c1' } });
    expect(keys()).not.toContainEqual(['messages', 'c1']);
    expect(keys()).toContainEqual(['conversation', 'c1']);
  });

  it('inbox.* recarrega caixas e conversas (a visibilidade pode ter mudado)', () => {
    const { qc, keys } = spyOn();
    applyEvent(qc, { type: 'inbox.updated', payload: {} });
    expect(keys()).toEqual([['inboxes'], ['conversations'], ['counts']]);
  });

  it('tipo desconhecido não invalida nada', () => {
    const { qc, keys } = spyOn();
    applyEvent(qc, { type: 'algo.novo', payload: {} });
    expect(keys()).toEqual([]);
  });
});
