const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 210000;
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'english-vocabulary-api' }, 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/auth/register') {
        return await register(request, env, cors);
      }
      if (request.method === 'POST' && url.pathname === '/auth/login') {
        return await login(request, env, cors);
      }
      if (request.method === 'GET' && url.pathname === '/auth/me') {
        return await me(request, env, cors);
      }
      if (request.method === 'POST' && url.pathname === '/auth/logout') {
        return await logout(request, env, cors);
      }
      return json({ error: 'Маршрут не найден', code: 'NOT_FOUND' }, 404, cors);
    } catch (error) {
      console.error(error);
      return json({ error: 'Внутренняя ошибка сервера', code: 'SERVER_ERROR' }, 500, cors);
    }
  }
};

function corsHeaders(origin, env) {
  const allowed = new Set(
    String(env.ALLOWED_ORIGINS || 'https://rmg78n94h5-maker.github.io')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  });
  if (allowed.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), { status, headers });
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) throw new ClientError('Ожидается JSON', 'BAD_CONTENT_TYPE', 415);
  return request.json();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function cleanDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

class ClientError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function register(request, env, cors) {
  try {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const displayName = cleanDisplayName(body.displayName);
    const password = String(body.password || '');

    if (!validEmail(email)) throw new ClientError('Введите корректный email', 'INVALID_EMAIL');
    if (displayName.length < 2) throw new ClientError('Имя должно содержать хотя бы 2 символа', 'INVALID_NAME');
    if (password.length < 8 || password.length > 128) throw new ClientError('Пароль должен содержать от 8 до 128 символов', 'INVALID_PASSWORD');

    const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (exists) throw new ClientError('Аккаунт с таким email уже существует', 'EMAIL_EXISTS', 409);

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    const passwordData = await hashPassword(password);

    await env.DB.prepare(
      'INSERT INTO users (id, email, display_name, password_hash, password_salt, password_iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, email, displayName, passwordData.hash, passwordData.salt, PBKDF2_ITERATIONS, now, now).run();

    const session = await createSession(env, userId);
    return json({ token: session.token, user: publicUser({ id: userId, email, display_name: displayName, created_at: now }) }, 201, cors);
  } catch (error) {
    return clientErrorResponse(error, cors);
  }
}

async function login(request, env, cors) {
  try {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!validEmail(email) || !password) throw new ClientError('Неверный email или пароль', 'INVALID_CREDENTIALS', 401);

    const user = await env.DB.prepare(
      'SELECT id, email, display_name, password_hash, password_salt, password_iterations, created_at FROM users WHERE email = ?'
    ).bind(email).first();

    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash, Number(user.password_iterations)))) {
      throw new ClientError('Неверный email или пароль', 'INVALID_CREDENTIALS', 401);
    }

    const session = await createSession(env, user.id);
    return json({ token: session.token, user: publicUser(user) }, 200, cors);
  } catch (error) {
    return clientErrorResponse(error, cors);
  }
}

async function me(request, env, cors) {
  try {
    const auth = await authenticatedUser(request, env);
    await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), auth.sessionId).run();
    return json({ user: publicUser(auth.user) }, 200, cors);
  } catch (error) {
    return clientErrorResponse(error, cors);
  }
}

async function logout(request, env, cors) {
  try {
    const token = bearerToken(request);
    if (token) {
      const tokenHash = await sha256Base64Url(token);
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    }
    return json({ ok: true }, 200, cors);
  } catch (error) {
    return clientErrorResponse(error, cors);
  }
}

function clientErrorResponse(error, cors) {
  if (error instanceof ClientError) return json({ error: error.message, code: error.code }, error.status, cors);
  console.error(error);
  return json({ error: 'Внутренняя ошибка сервера', code: 'SERVER_ERROR' }, 500, cors);
}

async function authenticatedUser(request, env) {
  const token = bearerToken(request);
  if (!token) throw new ClientError('Требуется вход в аккаунт', 'UNAUTHORIZED', 401);

  const tokenHash = await sha256Base64Url(token);
  const row = await env.DB.prepare(
    `SELECT sessions.id AS session_id, sessions.expires_at, users.id, users.email, users.display_name, users.created_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?`
  ).bind(tokenHash).first();

  if (!row) throw new ClientError('Сессия недействительна', 'UNAUTHORIZED', 401);
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.session_id).run();
    throw new ClientError('Сессия истекла', 'SESSION_EXPIRED', 401);
  }

  return { sessionId: row.session_id, user: row };
}

function bearerToken(request) {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

async function createSession(env, userId) {
  const token = randomToken(32);
  const tokenHash = await sha256Base64Url(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, tokenHash, expires.toISOString(), now.toISOString(), now.toISOString()).run();
  return { id, token };
}

async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToBase64Url(saltBytes);
  const hash = await derivePassword(password, saltBytes, PBKDF2_ITERATIONS);
  return { salt, hash: bytesToBase64Url(hash) };
}

async function verifyPassword(password, salt, expectedHash, iterations) {
  const derived = await derivePassword(password, base64UrlToBytes(salt), iterations || PBKDF2_ITERATIONS);
  const expected = base64UrlToBytes(expectedHash);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i += 1) diff |= derived[i] ^ expected[i];
  return diff === 0;
}

async function derivePassword(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

function randomToken(length) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: user.created_at
  };
}
