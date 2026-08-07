import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Alert, Button, Card, Field, Input } from '../components/ui';

/** FR-723 — self-serve free trial: no payment, straight into the setup wizard (FR-100). */
export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    legalName: '',
    tradeName: '',
    ownerName: '',
    email: '',
    phone: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);
    try {
      await register({
        legalName: form.legalName.trim(),
        tradeName: form.tradeName.trim() || undefined,
        ownerName: form.ownerName.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim() || undefined,
        password: form.password,
      });
      navigate('/setup', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not create your account — please try again');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-ink-950 via-ink-900 to-slate-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-ink-500 text-lg font-bold text-white">
            L
          </div>
          <h1 className="text-xl font-semibold text-white">Start your free trial</h1>
          <p className="mt-1 text-[13px] text-ink-300">No card needed. You'll be billing in minutes.</p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            {error && <Alert tone="rose">{error}</Alert>}

            <Field label="Firm's legal name" required error={fieldErrors.legalName}>
              <Input value={form.legalName} onChange={set('legalName')} required autoFocus placeholder="Sharma Printers" />
            </Field>

            <Field label="Trade name" hint="Shown on documents if different from the legal name" error={fieldErrors.tradeName}>
              <Input value={form.tradeName} onChange={set('tradeName')} placeholder="Sharma Flex & Digital" />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Your name" required error={fieldErrors.ownerName}>
                <Input value={form.ownerName} onChange={set('ownerName')} required />
              </Field>
              <Field label="Mobile" error={fieldErrors.phone}>
                <Input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="98XXXXXXXX" />
              </Field>
            </div>

            <Field label="Email" required error={fieldErrors.email}>
              <Input type="email" autoComplete="username" value={form.email} onChange={set('email')} required />
            </Field>

            <Field label="Password" required hint="At least 8 characters" error={fieldErrors.password}>
              <Input
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={set('password')}
                minLength={8}
                required
              />
            </Field>

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Creating your shop…' : 'Create account'}
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-[13px] text-ink-300">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-white underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
