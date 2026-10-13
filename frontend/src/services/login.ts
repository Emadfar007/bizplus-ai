import type { LoginConfig, LoginRequest, LoginResult } from '@bizplus/shared';
import { API_BASE, request, RequestError } from './api';

// A rejected login is a completed test with an incident, so retain its response.
async function submit(session: string, payload: LoginRequest): Promise<LoginResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Demo-Session': session },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    if (response.ok && result?.status === 'successful') return result as LoginResult;
    if (response.status === 401 && result?.status === 'rejected' && result?.code === 'LOGIN_REJECTED') return result as LoginResult;
    throw new RequestError(result?.error || `The login service returned HTTP ${response.status}.`, response.status, result?.code);
  } catch (cause) {
    if (cause instanceof RequestError) throw cause;
    if (cause instanceof DOMException && cause.name === 'AbortError') throw new RequestError('The login service took too long to respond. Please try again.', 0, 'TIMEOUT');
    throw new RequestError('The login service could not be reached. Check the backend connection and try again.', 0, 'NETWORK');
  } finally { clearTimeout(timer); }
}

export const loginApi = {
  config: (session: string) => request<LoginConfig>('/api/login/config', session),
  submit,
};
