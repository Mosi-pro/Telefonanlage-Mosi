let csrf = null;
export const state = { user: null, hostName: '', version: '' };

export class ApiError extends Error {
  constructor(message, status, field) { super(message); this.status = status; this.field = field; }
}

export async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...headers } };
  if (body !== undefined && !raw) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (raw) opts.body = body;
  if (csrf && method !== 'GET') opts.headers['X-CSRF-Token'] = csrf;
  let res;
  try { res = await fetch(`/api${path}`, opts); }
  catch { throw new ApiError('Server nicht erreichbar – Netzwerk oder Dienst prüfen', 0); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') { window.dispatchEvent(new Event('mosi:logout')); }
    throw new ApiError(data?.error || `Fehler ${res.status}`, res.status, data?.field);
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export async function login(username, password) {
  const r = await api('POST', '/login', { username, password });
  csrf = r.csrf; state.user = r.user;
  const s = await get('/session'); state.hostName = s.hostName; state.version = s.version;
  return r.user;
}
export async function restore() {
  try { const s = await get('/session'); csrf = s.csrf; state.user = s.user; state.hostName = s.hostName; state.version = s.version; return true; }
  catch { return false; }
}
export async function logout() { try { await post('/logout'); } catch { /* ignore */ } csrf = null; state.user = null; }
