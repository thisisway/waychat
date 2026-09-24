import type { AttachmentItem } from '@waychat/ui';
import { useCallback, useRef, useState } from 'react';
import { get, post } from './api.js';
import type { MessageAttachment } from './types.js';

/** Espelha as regras do servidor (a API é quem decide; isto só evita uma ida à rede à toa). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
const ALLOWED = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'pdf',
  'mp3',
  'ogg',
  'oga',
  'opus',
  'wav',
  'm4a',
  'mp4',
  'mov',
  'webm',
  'txt',
  'csv',
  'log',
];
export const ACCEPT = ALLOWED.map((e) => `.${e}`).join(',');

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

interface UploadForm {
  url: string;
  fields: Record<string, string>;
}
interface AttachmentRes {
  attachment: MessageAttachment;
}

/** Envio direto ao S3 com o formulário assinado: os campos primeiro e o arquivo por último. */
async function putToStorage(form: UploadForm, file: File): Promise<void> {
  const body = new FormData();
  for (const [k, v] of Object.entries(form.fields)) body.append(k, v);
  body.append('file', file);
  const res = await fetch(form.url, { method: 'POST', body });
  if (!res.ok) throw new Error('Falha ao enviar o arquivo.');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera a varredura: consulta o andamento até virar `clean` (ou falhar). */
async function waitClean(id: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const { attachment } = await get<AttachmentRes>(`/attachments/${id}`);
    if (attachment.status === 'clean') return;
    if (attachment.status === 'infected' || attachment.status === 'rejected') {
      throw new Error('O arquivo foi bloqueado pela verificação de segurança.');
    }
    await sleep(1000);
  }
  throw new Error('Não foi possível verificar o arquivo agora. Tente de novo.');
}

/** Abre o anexo numa nova aba com um link assinado de 5 minutos (buscado só no clique). */
export async function openAttachment(id: string): Promise<void> {
  const { url } = await get<{ url: string }>(`/attachments/${id}/download`);
  window.open(url, '_blank', 'noopener');
}

function validate(file: File): string | null {
  if (!ALLOWED.includes(extensionOf(file.name))) return 'Tipo não permitido';
  if (file.size === 0) return 'Arquivo vazio';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'Maior que 10 MB';
  return null;
}

/**
 * Rascunho de anexos de UMA conversa: pede a URL assinada, envia ao S3, conclui e espera a varredura. Só os `ready`
 * podem ir na mensagem. O componente é remontado por conversa, então o rascunho não vaza de uma para outra.
 */
export function useAttachmentDrafts(conversationId: string) {
  const [drafts, setDrafts] = useState<AttachmentItem[]>([]);
  const counter = useRef(0);

  const patch = useCallback((id: string, p: Partial<AttachmentItem>) => {
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }, []);

  const attach = useCallback(
    (files: File[]) => {
      for (const file of files) {
        counter.current += 1;
        const tmp = `local-${String(counter.current)}`;
        const invalid = validate(file);
        setDrafts((d) =>
          d.length >= MAX_ATTACHMENTS
            ? d
            : [
                ...d,
                {
                  id: tmp,
                  name: file.name,
                  size: file.size,
                  status: invalid ? 'error' : 'uploading',
                  ...(invalid ? { error: invalid } : {}),
                },
              ],
        );
        if (invalid) continue;
        void (async () => {
          let current = tmp;
          try {
            const req = await post<{ attachment: MessageAttachment; upload: UploadForm }>(
              `/conversations/${conversationId}/attachments`,
              { file_name: file.name, size: file.size },
            );
            // o id do rascunho passa a ser o do servidor (é ele que vai em `attachment_ids`)
            current = req.attachment.id;
            patch(tmp, { id: current });
            await putToStorage(req.upload, file);
            const done = await post<AttachmentRes>(`/attachments/${current}/complete`);
            patch(current, { status: 'scanning' });
            if (done.attachment.status !== 'clean') await waitClean(current);
            patch(current, { status: 'ready' });
          } catch (e) {
            patch(current, {
              status: 'error',
              error: e instanceof Error ? e.message : 'Falhou',
            });
          }
        })();
      }
    },
    [conversationId, patch],
  );

  const remove = useCallback((id: string) => {
    setDrafts((d) => d.filter((x) => x.id !== id));
  }, []);
  const clear = useCallback(() => {
    setDrafts([]);
  }, []);

  return { drafts, attach, remove, clear };
}
