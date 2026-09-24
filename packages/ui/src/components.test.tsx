import { fireEvent, render, screen } from '@testing-library/react';
import { Bell, MessageSquare } from 'lucide-react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Accordion,
  AccordionSection,
  Avatar,
  Badge,
  Button,
  Chip,
  Composer,
  ConversationListItem,
  IconButton,
  InfoCard,
  Input,
  MessageBubble,
  NoteCard,
  Search,
  SidebarNavItem,
  Tooltip,
  TooltipProvider,
  TopNavTab,
  UnreadBadge,
  initials,
  resolveTheme,
  setTheme,
} from './index.js';

beforeAll(() => {
  // Radix usa ResizeObserver, ausente no jsdom
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('Button', () => {
  it('loading desabilita, marca aria-busy e mostra spinner', () => {
    render(<Button loading>Salvar</Button>);
    const b = screen.getByRole('button', { name: 'Salvar' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
  });

  it('não é submit por padrão (evita enviar formulário sem querer)', () => {
    render(<Button>Ok</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('dispara onClick', () => {
    const fn = vi.fn();
    render(<Button onClick={fn}>Ir</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('IconButton', () => {
  it('o label vira o nome acessível e o ícone fica escondido', () => {
    render(<IconButton label="Ligar" icon={<Bell />} />);
    expect(screen.getByRole('button', { name: 'Ligar' })).toBeInTheDocument();
  });
});

describe('Input e Search', () => {
  it('associa label ao campo', () => {
    render(<Input label="E-mail" />);
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
  });

  it('erro: aria-invalid e mensagem ligada por aria-describedby', () => {
    render(<Input label="Senha" error="Muito curta" />);
    const input = screen.getByLabelText('Senha');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Muito curta');
  });

  it('Search é um searchbox com nome acessível', () => {
    render(<Search />);
    expect(screen.getByRole('searchbox', { name: 'Buscar...' })).toBeInTheDocument();
  });
});

describe('Avatar', () => {
  it('iniciais: primeira e última palavra', () => {
    expect(initials('Loren Quigley')).toBe('LQ');
    expect(initials('  ana  maria  souza ')).toBe('AS');
    expect(initials('Ana')).toBe('A');
    expect(initials('')).toBe('?');
  });

  it('presença é dita a leitores de tela, não só mostrada em cor', () => {
    render(<Avatar name="Paul Lean" presence="online" />);
    expect(screen.getByRole('img', { name: 'Paul Lean' })).toHaveTextContent('online');
  });

  it('imagem quebrada cai para as iniciais', () => {
    const { container } = render(<Avatar name="Esther Howard" src="/nao-existe.png" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(screen.getByRole('img', { name: 'Esther Howard' })).toHaveTextContent('EH');
  });

  it('UnreadBadge: some com 0 e limita em 99+', () => {
    const { container, rerender } = render(<UnreadBadge count={0} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<UnreadBadge count={250} />);
    expect(screen.getByLabelText('250 não lidas')).toHaveTextContent('99+');
  });
});

describe('Badge e Chip', () => {
  it('o status é texto (não depende só da cor)', () => {
    render(<Badge>Respondido</Badge>);
    expect(screen.getByText('Respondido')).toBeVisible();
  });

  it('Chip remove pelo botão "Remover"', () => {
    const fn = vi.fn();
    render(<Chip onRemove={fn}>VIP</Chip>);
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('Accordion', () => {
  it('abre e fecha pelo teclado/clique e expõe aria-expanded', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionSection value="notas" title="Notas" count={2}>
          Conteúdo das notas
        </AccordionSection>
      </Accordion>,
    );
    const trigger = screen.getByRole('button', { name: /Notas/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Conteúdo das notas')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Conteúdo das notas')).toBeVisible();
  });
});

describe('Tooltip', () => {
  it('abre com o foco do teclado', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Usar template">
          <button type="button">T</button>
        </Tooltip>
      </TooltipProvider>,
    );
    fireEvent.focus(screen.getByRole('button', { name: 'T' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Usar template');
  });
});

describe('Cards e navegação', () => {
  it('NoteCard mostra texto e meta', () => {
    render(<NoteCard meta="12 mar 2026">Cliente pediu retorno</NoteCard>);
    expect(screen.getByText('Cliente pediu retorno')).toBeVisible();
    expect(screen.getByText('12 mar 2026')).toBeVisible();
  });

  it('InfoCard: botão de ligar nomeado com o contato', () => {
    const fn = vi.fn();
    render(
      <InfoCard
        name="Brandon Madsen"
        phone="+55 11 90000-0000"
        status={{ label: 'Respondido' }}
        onCall={fn}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ligar para Brandon Madsen' }));
    expect(fn).toHaveBeenCalledOnce();
    expect(screen.getByText('Respondido')).toBeVisible();
  });

  it('item ativo da sidebar e aba ativa usam aria-current', () => {
    render(
      <>
        <SidebarNavItem icon={MessageSquare} label="Todas" count={18} active />
        <SidebarNavItem icon={MessageSquare} label="Lixeira" />
        <TopNavTab icon={MessageSquare} active>
          Conversas
        </TopNavTab>
      </>,
    );
    expect(screen.getByRole('button', { name: /Todas/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Lixeira/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Conversas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('tema', () => {
  it('setTheme aplica data-theme e persiste; resolveTheme lê a preferência salva', () => {
    setTheme('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(resolveTheme()).toBe('dark');
    setTheme('light');
    expect(resolveTheme()).toBe('light');
  });

  it('sem preferência salva segue o sistema', () => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(resolveTheme()).toBe('dark');
    vi.unstubAllGlobals();
  });
});

describe('componentes de conversa', () => {
  it('MessageBubble: recebida mostra autor; enviada mostra origem e status; nota mostra o rótulo', () => {
    const { rerender } = render(
      <MessageBubble direction="in" author="Brandon" time="11:18">
        Olá
      </MessageBubble>,
    );
    expect(screen.getByText('Brandon')).toBeVisible();
    rerender(
      <MessageBubble direction="out" time="11:19" via="via Site" status="read">
        Oi!
      </MessageBubble>,
    );
    expect(screen.getByText('via Site')).toBeVisible();
    expect(screen.getByText('Lida')).toBeInTheDocument(); // status também por texto, não só ícone
    rerender(
      <MessageBubble direction="out" time="11:20" note>
        segredo
      </MessageBubble>,
    );
    expect(screen.getByText('Nota interna')).toBeVisible();
  });

  it('ConversationListItem: mostra não lidas e marca a selecionada', () => {
    const fn = vi.fn();
    render(
      <ConversationListItem
        name="Loren Quigley"
        preview="Awesome!"
        time="11:29"
        unread={2}
        selected
        onClick={fn}
      />,
    );
    const b = screen.getByRole('button', { name: /Loren Quigley/ });
    expect(b).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('2 não lidas')).toBeVisible();
    fireEvent.click(b);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('Composer: Enter envia, Shift+Enter não; vazio não envia; nota interna muda o modo', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<Composer onSend={onSend} />);
    const box = screen.getByLabelText('Escrever mensagem');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled(); // vazio
    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('oi', 'reply');
    });
    await vi.waitFor(() => {
      expect(box).toHaveValue('');
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Nota interna' }));
    const note = screen.getByLabelText('Escrever nota interna');
    fireEvent.change(note, { target: { value: 'so equipe' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(onSend).toHaveBeenLastCalledWith('so equipe', 'note');
    });
  });

  it('Composer: se o envio falha o texto permanece; "/" sugere respostas prontas e Tab escolhe', async () => {
    const failing = vi.fn().mockResolvedValue(false);
    const { unmount } = render(<Composer onSend={failing} />);
    const box = screen.getByLabelText('Escrever mensagem');
    fireEvent.change(box, { target: { value: 'tentando' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() => {
      expect(failing).toHaveBeenCalled();
    });
    expect(box).toHaveValue('tentando');
    unmount();

    render(
      <Composer
        onSend={vi.fn()}
        canned={[
          { shortcut: 'ola', content: 'Olá! Como posso ajudar?' },
          { shortcut: 'obrigado', content: 'Por nada!' },
        ]}
      />,
    );
    const b2 = screen.getByLabelText('Escrever mensagem');
    fireEvent.change(b2, { target: { value: '/ol' } });
    expect(screen.getByRole('listbox', { name: 'Respostas prontas' })).toBeVisible();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(b2, { key: 'Tab' });
    expect(b2).toHaveValue('Olá! Como posso ajudar?');
  });
});

describe('anexos no chat', () => {
  const pronto = { id: 'a1', name: 'proposta.pdf', size: 2_400_000, status: 'ready' as const };

  it('MessageBubble lista os arquivos e avisa qual foi aberto', () => {
    const onOpen = vi.fn();
    render(
      <MessageBubble
        direction="in"
        time="10:00"
        attachments={[{ id: 'a1', name: 'proposta.pdf', size: 2_400_000 }]}
        onOpenAttachment={onOpen}
      >
        Segue
      </MessageBubble>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Baixar proposta.pdf' }));
    expect(onOpen).toHaveBeenCalledWith('a1');
    expect(screen.getByText('2,3 MB')).toBeInTheDocument();
  });

  it('Composer: com arquivo pronto envia mesmo sem texto', () => {
    const onSend = vi.fn(() => true);
    render(<Composer onSend={onSend} drafts={[pronto]} onAttach={vi.fn()} />);
    const send = screen.getByRole('button', { name: 'Enviar mensagem' });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith('', 'reply');
  });

  it('Composer: enquanto o arquivo sobe ou é verificado, não envia', () => {
    const onSend = vi.fn(() => true);
    render(
      <Composer onSend={onSend} onAttach={vi.fn()} drafts={[{ ...pronto, status: 'scanning' }]} />,
    );
    fireEvent.change(screen.getByLabelText('Escrever mensagem'), { target: { value: 'oi' } });
    expect(screen.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
    expect(screen.getByText('Verificando…')).toBeInTheDocument();
  });

  it('Composer: escolher arquivos chama onAttach; remover chama onRemoveDraft; nota interna esconde o clipe', () => {
    const onAttach = vi.fn();
    const onRemove = vi.fn();
    render(
      <Composer onSend={vi.fn()} onAttach={onAttach} onRemoveDraft={onRemove} drafts={[pronto]} />,
    );
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Selecionar arquivos'), { target: { files: [file] } });
    expect(onAttach).toHaveBeenCalledWith([file]);
    fireEvent.click(screen.getByRole('button', { name: 'Remover proposta.pdf' }));
    expect(onRemove).toHaveBeenCalledWith('a1');
    fireEvent.click(screen.getByRole('tab', { name: 'Nota interna' }));
    expect(screen.queryByRole('button', { name: 'Anexar arquivo' })).not.toBeInTheDocument();
    expect(screen.queryByText('proposta.pdf')).not.toBeInTheDocument();
  });

  it('chip de erro mostra o motivo', () => {
    render(
      <Composer
        onSend={vi.fn()}
        onAttach={vi.fn()}
        drafts={[{ id: 'x', name: 'v.exe', size: 5, status: 'error', error: 'Tipo não permitido' }]}
      />,
    );
    expect(screen.getByText('Tipo não permitido')).toBeInTheDocument();
  });
});
