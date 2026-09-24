/** Limite por anexo (também imposto pelo S3 na URL assinada). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface Kind {
  contentType: string;
  extensions: string[];
  /** Confere os primeiros bytes. */
  match: (b: Uint8Array) => boolean;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, s: string) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)).every((c, i) => b[at + i] === c);

const utf8 = (b: Uint8Array) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

/**
 * Lista fechada. O tipo vem do CONTEÚDO (assinatura), nunca do nome ou do Content-Type que o cliente declarou;
 * e a extensão declarada precisa combinar com o conteúdo (um .pdf que é executável é recusado).
 * Fora daqui: HTML, SVG, scripts, executáveis, ZIP/Office (podem carregar macros) — o cliente pode enviar por link.
 */
const KINDS: Kind[] = [
  {
    contentType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    match: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    contentType: 'image/png',
    extensions: ['png'],
    match: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    contentType: 'image/gif',
    extensions: ['gif'],
    match: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
  },
  {
    contentType: 'image/webp',
    extensions: ['webp'],
    match: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  },
  { contentType: 'application/pdf', extensions: ['pdf'], match: (b) => ascii(b, 0, '%PDF-') },
  {
    contentType: 'audio/mpeg',
    extensions: ['mp3'],
    match: (b) => ascii(b, 0, 'ID3') || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  },
  {
    contentType: 'audio/ogg',
    extensions: ['ogg', 'oga', 'opus'],
    match: (b) => ascii(b, 0, 'OggS'),
  },
  {
    contentType: 'audio/wav',
    extensions: ['wav'],
    match: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'),
  },
  {
    contentType: 'audio/mp4',
    extensions: ['m4a'],
    match: (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'M4A ') || ascii(b, 8, 'mp42')),
  },
  {
    contentType: 'video/mp4',
    extensions: ['mp4', 'mov'],
    match: (b) => ascii(b, 4, 'ftyp') && !ascii(b, 8, 'M4A '),
  },
  {
    contentType: 'video/webm',
    extensions: ['webm'],
    match: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  },
  {
    contentType: 'text/plain',
    extensions: ['txt', 'csv', 'log'],
    // texto puro não tem assinatura: exige UTF-8 válido, sem byte nulo. Os 4 KB lidos podem cortar um caractere
    // no meio, então tolera até 3 bytes soltos no fim.
    match: (b) =>
      b.length > 0 &&
      !b.includes(0) &&
      [0, 1, 2, 3].some((cut) => utf8(b.subarray(0, b.length - cut))),
  },
];

export const allowedExtensions = KINDS.flatMap((k) => k.extensions);

const extensionOf = (fileName: string): string => {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase();
};

/** Extensão permitida (checagem barata, antes de emitir a URL de upload). */
export const extensionAllowed = (fileName: string): boolean =>
  allowedExtensions.includes(extensionOf(fileName));

/**
 * Tipo real do arquivo pelos primeiros bytes, ou `null` se não está na lista ou se a extensão não combina.
 * `head` deve ter até 4 KB.
 */
export function detectContentType(head: Uint8Array, fileName: string): string | null {
  const ext = extensionOf(fileName);
  const kind = KINDS.find((k) => k.extensions.includes(ext));
  return kind?.match(head) ? kind.contentType : null;
}

/** Nome seguro para exibir/baixar: sem caminho, sem caracteres de controle ou aspas, tamanho limitado. */
export function sanitizeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_')
    .trim();
  const cleaned = base.replace(/^\.+/, '').slice(-120);
  return cleaned || 'arquivo';
}
