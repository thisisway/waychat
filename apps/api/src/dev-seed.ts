import { randomUUID } from 'node:crypto';
import {
  addLabel,
  addMember,
  authenticate,
  coreConfigFromEnv,
  createCannedResponse,
  createCtx,
  createInbox,
  createLabel,
  DomainError,
  listConversations,
  listRoles,
  login,
  receiveInboundMessage,
  registerAccount,
  sendMessage,
  setInboxMembers,
  updateConversation,
  type Actor,
  type Ctx,
} from '@waychat/core';
import { createDb } from '@waychat/db';
import { loadEnv } from '@waychat/shared';

/**
 * Dados de demonstração para ver o painel funcionando. SÓ para desenvolvimento local: recusa rodar em produção
 * ou apontando para um endereço que não seja localhost. A senha abaixo é pública e fictícia.
 */
const env = loadEnv();
if (
  env.NODE_ENV === 'production' ||
  !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.PUBLIC_URL)
) {
  console.error(
    'dev-seed recusado: só roda em desenvolvimento local (NODE_ENV != production e PUBLIC_URL em localhost).',
  );
  process.exit(1);
}

const PASSWORD = 'waychat-teste-2026!';
const OWNER = 'demo@waychat.dev';
const AGENT = 'ana@waychat.dev';

const handle = createDb(env.DATABASE_URL);
const ctx: Ctx = createCtx(handle.db, coreConfigFromEnv(env));

async function actorOf(email: string): Promise<Actor> {
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('login de demonstração exigiu 2FA');
  return authenticate(ctx, r.tokens.accessToken);
}

try {
  let accountId: string;
  try {
    ({ accountId } = await registerAccount(ctx, {
      accountName: 'Loja Demo',
      ownerName: 'Demo Silva',
      email: OWNER,
      password: PASSWORD,
    }));
  } catch (e) {
    if (e instanceof DomainError && e.code === 'email_taken') {
      console.log(`Dados de demonstração já existem.\n  e-mail: ${OWNER}\n  senha:  ${PASSWORD}`);
      process.exit(0);
    }
    throw e;
  }

  const owner = await actorOf(OWNER);
  const agentRole = (await listRoles(ctx, owner)).find((r) => r.name === 'Agente');
  if (!agentRole) throw new Error('papel Agente ausente');
  const { userId: agentId } = await addMember(ctx, owner, {
    email: AGENT,
    name: 'Ana Souza',
    password: PASSWORD,
    roleId: agentRole.id,
  });

  const { inbox } = await createInbox(ctx, owner, { name: 'Site', channelType: 'widget' });
  await setInboxMembers(ctx, owner, inbox.id, [agentId]);
  const vip = await createLabel(ctx, owner, { name: 'VIP', color: '#1560ff' });
  await createLabel(ctx, owner, { name: 'Suporte', color: '#0a9426' });
  await createLabel(ctx, owner, { name: 'Financeiro', color: '#d7600f' });
  await createCannedResponse(ctx, owner, {
    shortcut: 'ola',
    content: 'Olá! Tudo bem? Como posso ajudar?',
  });
  await createCannedResponse(ctx, owner, {
    shortcut: 'obrigado',
    content: 'Por nada! Qualquer dúvida é só chamar.',
  });
  await createCannedResponse(ctx, owner, {
    shortcut: 'prazo',
    content: 'O prazo de entrega é de 3 a 5 dias úteis.',
  });

  const ana = await actorOf(AGENT);
  const visit = (who: string, name: string, phone?: string, email?: string) => ({
    channel: 'widget',
    externalId: who,
    name,
    phone: phone ?? null,
    email: email ?? null,
  });
  const inbound = (
    who: string,
    name: string,
    text: string,
    extra: { phone?: string; email?: string } = {},
  ) =>
    receiveInboundMessage(ctx, {
      accountId,
      inboxId: inbox.id,
      identity: visit(who, name, extra.phone, extra.email),
      content: text,
    });
  const reply = (conversationId: string, text: string, priv = false) =>
    sendMessage(ctx, ana, {
      conversationId,
      content: text,
      clientMessageId: randomUUID(),
      private: priv,
    });

  const brandon = await inbound(
    'v-brandon',
    'Brandon Madsen',
    'Oi! Vocês fazem a demo do produto por Zoom?',
    {
      phone: '+14371234567',
      email: 'm.brandon@gmail.com',
    },
  );
  await reply(
    brandon.conversationId,
    'Fazemos sim! Tenho horários de 30 a 60 minutos, qual prefere?',
  );
  await inbound('v-brandon', 'Brandon Madsen', 'E às 14:30?');
  await reply(brandon.conversationId, 'Cliente pediu retorno depois do almoço.', true);
  await updateConversation(ctx, ana, brandon.conversationId, {
    assigneeId: agentId,
    priority: 'high',
  });
  await addLabel(ctx, ana, brandon.conversationId, vip.id);

  await inbound('v-loren', 'Loren Quigley', 'Bom dia! O pedido 4821 ainda não chegou.', {
    phone: '+5511987654321',
  });
  await inbound('v-loren', 'Loren Quigley', 'Consegue verificar para mim?');

  const esther = await inbound('v-esther', 'Esther Howard', 'Vocês emitem nota fiscal para CNPJ?', {
    email: 'esther@empresa.com',
  });
  await reply(esther.conversationId, 'Emitimos sim! Me passe o CNPJ e o e-mail para envio.');

  const dianne = await inbound(
    'v-dianne',
    'Dianne Russell',
    'Obrigada pela ajuda, deu tudo certo!',
  );
  await reply(dianne.conversationId, 'Que bom! Se precisar, estamos por aqui.');
  await updateConversation(ctx, ana, dianne.conversationId, { status: 'resolved' });

  await inbound('v-cody', 'Cody Fisher', 'Qual o prazo de entrega para o Nordeste?', {
    phone: '+5581999990000',
  });
  await inbound('v-marvin', 'Marvin McKinney', 'Preciso trocar o endereço de cobrança.');

  const total = (await listConversations(ctx, owner, {})).items.length;
  console.log(`Dados de demonstração criados (${String(total)} conversas).`);
  console.log(`\n  Dono:    ${OWNER}\n  Agente:  ${AGENT}\n  Senha:   ${PASSWORD}\n`);
} finally {
  await handle.close();
}
