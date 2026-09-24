def edit(p, pairs):
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        assert a in s, (p, a[:70])
        s = s.replace(a, b, 1)
    open(p, 'w', encoding='utf-8').write(s)


edit('apps/web/src/attachments.ts', [("\nexport { ApiError };\n", "\n"), ("import { ApiError, get, post } from './api.js';", "import { get, post } from './api.js';")])
edit('apps/web/src/queries.ts', [
    ("    mutationFn: (v: { content: string; private: boolean; clientMessageId: string }) =>\n      post<{ message: Message }>(`/conversations/${conversationId}/messages`, {\n        content: v.content,\n        private: v.private,\n        client_message_id: v.clientMessageId,\n      }),",
     "    mutationFn: (v: {\n      content: string;\n      private: boolean;\n      clientMessageId: string;\n      attachments?: { id: string; name: string; size: number }[];\n    }) =>\n      post<{ message: Message }>(`/conversations/${conversationId}/messages`, {\n        content: v.content,\n        private: v.private,\n        client_message_id: v.clientMessageId,\n        ...(v.attachments?.length ? { attachment_ids: v.attachments.map((a) => a.id) } : {}),\n      }),"),
    ("        clientMessageId: v.clientMessageId,\n        createdAt: new Date().toISOString(),\n      };",
     "        clientMessageId: v.clientMessageId,\n        attachments: (v.attachments ?? []).map((a) => ({\n          id: a.id,\n          fileName: a.name,\n          contentType: null,\n          size: a.size,\n          status: 'clean' as const,\n        })),\n        createdAt: new Date().toISOString(),\n      };"),
])
edit('apps/web/src/pages/Conversations.tsx', [
    ("  const send = useSendMessage(id, me);\n", "  const send = useSendMessage(id, me);\n  const files = useAttachmentDrafts(id);\n"),
    ("            onTyping={notifyTyping}\n            disabled={!c}\n            onSend={async (text, mode) => {\n              try {\n                await send.mutateAsync({\n                  content: text,\n                  private: mode === 'note',\n                  clientMessageId: crypto.randomUUID(),\n                });\n                return true;",
     "            onTyping={notifyTyping}\n            disabled={!c}\n            drafts={files.drafts}\n            onAttach={files.attach}\n            onRemoveDraft={files.remove}\n            accept={ACCEPT}\n            onSend={async (text, mode) => {\n              try {\n                const attach =\n                  mode === 'reply' ? files.drafts.filter((d) => d.status === 'ready') : [];\n                await send.mutateAsync({\n                  content: text,\n                  private: mode === 'note',\n                  clientMessageId: crypto.randomUUID(),\n                  attachments: attach,\n                });\n                if (attach.length > 0) files.clear();\n                return true;"),
    ("      note={m.private}\n      automated={m.senderType === 'bot'}\n    >",
     "      note={m.private}\n      automated={m.senderType === 'bot'}\n      attachments={m.attachments.map((a) => ({ id: a.id, name: a.fileName, size: a.size }))}\n      onOpenAttachment={(attId) => {\n        void openAttachment(attId);\n      }}\n    >"),
    ("import { makeTypingNotifier,", "import { ACCEPT, openAttachment, useAttachmentDrafts } from '../attachments.js';\nimport { makeTypingNotifier,"),
])
