/**
 * In development Vite proxies `/api` to localhost:4000, so the relative default
 * is right. In a deployed build the web app and the API are separate origins —
 * set VITE_API_URL at build time to the API service's URL.
 *
 * Accepts it with or without the `/api` suffix, because Render's
 * RENDER_EXTERNAL_URL hands over a bare origin:
 *   https://leo-ink-api.onrender.com      → https://leo-ink-api.onrender.com/api
 *   https://leo-ink-api.onrender.com/api  → unchanged
 */
function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (!configured) return '/api';
  const trimmed = configured.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

const API_BASE = resolveApiBase();

const TOKEN_KEY = 'leoink.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export interface ApiErrorShape {
  code: string;
  message: string;
  fields?: Array<{ field: string; message: string }>;
  details?: unknown;
  lineNo?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiErrorShape,
  ) {
    super(payload.message);
    this.name = 'ApiError';
  }

  /** Field-level errors, keyed by field name, for inline form display. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.payload.fields ?? []) out[f.field] = f.message;
    return out;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, payload?.error ?? { code: 'UNKNOWN', message: res.statusText });
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/**
 * Response envelope convention (see server/src/modules/*):
 *   - a single entity is returned at the TOP LEVEL — `{ id, name, … }`
 *   - a list is wrapped — `{ data: [...], page, pageSize, total }`
 * Type `api.get`/`api.post` with the entity itself for the former, and with
 * `Paged<T>` for the latter.
 */

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
