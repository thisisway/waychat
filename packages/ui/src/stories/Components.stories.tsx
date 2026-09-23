import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Archive,
  Ban,
  Bell,
  CheckCircle2,
  Contact,
  Filter,
  MessageSquare,
  Phone,
  Send,
  Trash2,
  UserCheck,
} from 'lucide-react';
import {
  Accordion,
  AccordionSection,
  Avatar,
  Badge,
  Button,
  Chip,
  IconButton,
  InfoCard,
  Input,
  NoteCard,
  Search,
  SidebarNavItem,
  Tooltip,
  TopNavTab,
  UnreadBadge,
} from '../index.js';

const meta = { title: 'Componentes' } satisfies Meta;
export default meta;

type Story = StoryObj;

export const Botoes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>Primário</Button>
      <Button variant="outline">
        <CheckCircle2 className="size-4" aria-hidden /> Marcar como resolvida
      </Button>
      <Button variant="ghost">Cancelar</Button>
      <Button variant="danger">Excluir</Button>
      <Button loading>Salvando</Button>
      <Button disabled>Desabilitado</Button>
    </div>
  ),
};

export const BotoesDeIcone: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <IconButton label="Notificações" icon={<Bell />} />
      <IconButton variant="soft" label="Ligar" icon={<Phone />} />
      <IconButton variant="primary" label="Enviar" icon={<Send />} />
      <Tooltip content="Usar template">
        <IconButton label="Templates" icon={<Filter />} />
      </Tooltip>
    </div>
  ),
};

export const Campos: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-4">
      <Search />
      <Input label="E-mail" placeholder="voce@empresa.com" />
      <Input label="Senha" type="password" error="Use pelo menos 12 caracteres." />
      <Input label="Desabilitado" disabled placeholder="—" />
    </div>
  ),
};

export const AvataresEStatus: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar name="Loren Quigley" presence="online" />
      <Avatar name="Esther Howard" />
      <Avatar name="Dianne Russell" presence="offline" />
      <Avatar name="Brandon Madsen" size="lg" />
      <Avatar name="Paul Lean" size="xs" />
      <UnreadBadge count={3} />
      <Badge>Respondido</Badge>
      <Badge tone="neutral">Aguardando</Badge>
      <Badge tone="success">Resolvida</Badge>
      <Chip emoji="⭐" onRemove={() => undefined}>
        VIP
      </Chip>
    </div>
  ),
};

export const Cartoes: Story = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-3">
      <InfoCard
        name="Brandon Madsen"
        phone="+55 11 90000-0000"
        status={{ label: 'Respondido' }}
        onCall={() => undefined}
      />
      <NoteCard meta="12 mar 2026 · Ana">Cliente pediu retorno na quinta, depois das 14h.</NoteCard>
    </div>
  ),
};

export const Navegacao: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex gap-2 rounded-panel bg-surface px-4">
        <TopNavTab icon={Contact}>Contatos</TopNavTab>
        <TopNavTab icon={MessageSquare} active>
          Conversas
        </TopNavTab>
        <TopNavTab icon={Bell}>Campanhas</TopNavTab>
      </div>
      <div className="flex w-60 flex-col gap-1 rounded-panel bg-surface p-3">
        <SidebarNavItem icon={UserCheck} label="Não atribuídas" count={39} />
        <SidebarNavItem icon={MessageSquare} label="Todas" count={18} active />
        <SidebarNavItem icon={Ban} label="Bloqueados" />
        <SidebarNavItem icon={Archive} label="Arquivadas" count={4} />
        <SidebarNavItem icon={Trash2} label="Lixeira" />
      </div>
    </div>
  ),
};

export const PainelLateral: Story = {
  render: () => (
    <div className="max-w-xs rounded-panel bg-surface p-4">
      <Accordion type="multiple" defaultValue={['notas']}>
        <AccordionSection value="campanhas" title="Campanhas">
          <p className="text-meta text-fg-secondary">Nenhuma campanha.</p>
        </AccordionSection>
        <AccordionSection
          value="notas"
          title="Notas"
          count={1}
          action={
            <button type="button" className="text-meta font-medium text-primary-text">
              Adicionar
            </button>
          }
        >
          <NoteCard meta="12 mar 2026">Prefere contato por WhatsApp.</NoteCard>
        </AccordionSection>
        <AccordionSection value="tags" title="Tags" count={2}>
          <div className="flex flex-wrap gap-2">
            <Chip emoji="⭐">VIP</Chip>
            <Chip>Suporte</Chip>
          </div>
        </AccordionSection>
      </Accordion>
    </div>
  ),
};
