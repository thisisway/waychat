import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input } from '@waychat/ui';
import { useState, type SyntheticEvent } from 'react';
import { ApiError, post } from '../api.js';

type Step =
  | { kind: 'credentials' }
  | { kind: 'mfa'; challenge: string }
  | { kind: 'enroll'; challenge: string; secret?: string };

interface LoginResponse {
  status: 'authenticated' | 'mfa_required' | 'mfa_enrollment_required';
  challenge?: string;
}

export function LoginPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [form, setForm] = useState({ email: '', password: '', name: '', account: '' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const enter = async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    await nav({ to: '/', search: { c: undefined, f: 'all' } });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível conectar ao servidor.');
    } finally {
      setBusy(false);
    }
  };

  const onCredentials = (e: SyntheticEvent) => {
    e.preventDefault();
    void run(async () => {
      const path = mode === 'login' ? '/auth/login' : '/auth/register';
      const body =
        mode === 'login'
          ? { email: form.email, password: form.password }
          : {
              email: form.email,
              password: form.password,
              name: form.name,
              account_name: form.account,
            };
      const res = await post<LoginResponse>(path, body);
      if (res.status === 'authenticated') return enter();
      if (res.status === 'mfa_required' && res.challenge)
        setStep({ kind: 'mfa', challenge: res.challenge });
      if (res.status === 'mfa_enrollment_required' && res.challenge) {
        const begin = await post<{ secret: string }>('/auth/mfa/enroll/begin', {
          challenge: res.challenge,
        });
        setStep({ kind: 'enroll', challenge: res.challenge, secret: begin.secret });
      }
    });
  };

  const onMfa = (e: SyntheticEvent) => {
    e.preventDefault();
    if (step.kind === 'credentials') return;
    void run(async () => {
      if (step.kind === 'mfa') {
        const isCode = /^\d{6}$/.test(code.trim());
        await post('/auth/mfa/verify', {
          challenge: step.challenge,
          ...(isCode ? { code: code.trim() } : { recovery_code: code.trim() }),
        });
        return enter();
      }
      const done = await post<{ recovery_codes: string[] }>('/auth/mfa/enroll/complete', {
        challenge: step.challenge,
        code: code.trim(),
      });
      setRecovery(done.recovery_codes);
    });
  };

  return (
    <main className="grid min-h-full place-items-center bg-app p-4">
      <div className="w-full max-w-sm rounded-shell bg-surface p-8 shadow-soft">
        <h1 className="mb-1 text-title font-semibold text-fg">WayChat</h1>
        <p className="mb-6 text-meta text-fg-secondary">
          {mode === 'login' ? 'Entre para atender seus clientes.' : 'Crie sua conta para começar.'}
        </p>

        {recovery ? (
          <div className="flex flex-col gap-4">
            <p className="text-body text-fg">
              Verificação em duas etapas ativada. Guarde estes códigos de recuperação em um lugar
              seguro: cada um vale uma vez e não serão mostrados de novo.
            </p>
            <ul className="grid grid-cols-2 gap-2 rounded-card bg-surface-muted p-3 font-mono text-meta text-fg">
              {recovery.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button onClick={() => void enter()}>Continuar</Button>
          </div>
        ) : step.kind === 'credentials' ? (
          <form onSubmit={onCredentials} className="flex flex-col gap-4">
            {mode === 'register' ? (
              <>
                <Input
                  label="Nome da empresa"
                  value={form.account}
                  required
                  minLength={2}
                  onChange={(e) => {
                    setForm({ ...form, account: e.target.value });
                  }}
                />
                <Input
                  label="Seu nome"
                  value={form.name}
                  required
                  autoComplete="name"
                  onChange={(e) => {
                    setForm({ ...form, name: e.target.value });
                  }}
                />
              </>
            ) : null}
            <Input
              label="E-mail"
              type="email"
              autoComplete="username"
              value={form.email}
              required
              onChange={(e) => {
                setForm({ ...form, email: e.target.value });
              }}
            />
            <Input
              label="Senha"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={form.password}
              required
              minLength={mode === 'register' ? 12 : 1}
              onChange={(e) => {
                setForm({ ...form, password: e.target.value });
              }}
            />
            {mode === 'register' ? (
              <p className="-mt-2 text-caption text-fg-secondary">Use de 12 a 128 caracteres.</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-meta text-danger-text">
                {error}
              </p>
            ) : null}
            <Button type="submit" loading={busy}>
              {mode === 'login' ? 'Entrar' : 'Criar conta'}
            </Button>
            <button
              type="button"
              className="text-meta text-primary-text hover:underline"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? 'Criar uma conta' : 'Já tenho conta'}
            </button>
          </form>
        ) : (
          <form onSubmit={onMfa} className="flex flex-col gap-4">
            {step.kind === 'enroll' ? (
              <div className="flex flex-col gap-2 text-meta text-fg">
                <p>
                  Sua conta exige verificação em duas etapas. No app autenticador (Google
                  Authenticator, Authy…), adicione uma conta com esta chave e digite o código de 6
                  dígitos:
                </p>
                <code className="break-all rounded-control bg-surface-muted p-2 text-fg">
                  {step.secret}
                </code>
              </div>
            ) : (
              <p className="text-body text-fg">
                Digite o código de 6 dígitos do seu app autenticador (ou um código de recuperação).
              </p>
            )}
            <Input
              label="Código"
              value={code}
              autoComplete="one-time-code"
              inputMode="text"
              required
              autoFocus
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
            {error ? (
              <p role="alert" className="text-meta text-danger-text">
                {error}
              </p>
            ) : null}
            <Button type="submit" loading={busy}>
              Verificar
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
