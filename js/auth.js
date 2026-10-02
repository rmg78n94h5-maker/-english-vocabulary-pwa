import { getOne, putOne, deleteOne } from './db.js';

const SESSION_KEY = 'auth-session';

export function authConfigured(apiBaseUrl) {
  try {
    const url = new URL(String(apiBaseUrl || '').trim());
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}

function apiUrl(apiBaseUrl, path) {
  return `${String(apiBaseUrl || '').replace(/\/+$/, '')}${path}`;
}

async function request(apiBaseUrl, path, { method = 'GET', body, token } = {}) {
  if (!authConfigured(apiBaseUrl)) {
    const error = new Error('Сервер аккаунтов ещё не подключён');
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(apiUrl(apiBaseUrl, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
  } catch {
    const error = new Error('Не удалось связаться с сервером аккаунтов');
    error.code = 'AUTH_NETWORK_ERROR';
    throw error;
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || 'Ошибка сервера аккаунтов');
    error.code = payload.code || 'AUTH_REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }

  return payload;
}

export async function loadAuthSession() {
  return (await getOne('meta', SESSION_KEY)) || null;
}

export async function saveAuthSession(token, user) {
  const session = {
    key: SESSION_KEY,
    token,
    user,
    savedAt: new Date().toISOString()
  };
  await putOne('meta', session);
  return session;
}

export async function clearAuthSession() {
  await deleteOne('meta', SESSION_KEY);
}

export async function registerAccount(apiBaseUrl, { displayName, email, password }) {
  const payload = await request(apiBaseUrl, '/auth/register', {
    method: 'POST',
    body: { displayName, email, password }
  });
  await saveAuthSession(payload.token, payload.user);
  return payload;
}

export async function loginAccount(apiBaseUrl, { email, password }) {
  const payload = await request(apiBaseUrl, '/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  await saveAuthSession(payload.token, payload.user);
  return payload;
}

export async function fetchCurrentUser(apiBaseUrl, token) {
  return request(apiBaseUrl, '/auth/me', { token });
}

export async function logoutAccountRemote(apiBaseUrl, token) {
  if (!authConfigured(apiBaseUrl) || !token) return;
  await request(apiBaseUrl, '/auth/logout', { method: 'POST', token });
}
