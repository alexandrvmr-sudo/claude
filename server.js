// Волшебное зеркало — локальный сервер.
// Отдаёт две страницы (пульт и экран), хранит состояние в data/state.json
// и рассылает изменения всем открытым окнам через SSE.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.MIRROR_DATA || path.join(ROOT, 'data'); // MIRROR_DATA пригождается в тестах
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT) || 7777;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function defaultState() {
  return {
    rev: 0,
    settings: {
      title: 'Битва сильнейших',
      subtitle: 'Волшебное зеркало',
    },
    contests: [
      { id: id('c'), name: 'Испытание 1' },
      { id: id('c'), name: 'Испытание 2' },
      { id: id('c'), name: 'Испытание 3' },
    ],
    participants: [],
    // scores[participantId][contestId] = число или null
    scores: {},
    display: {
      mode: 'standby', // standby | leaderboard | contest | spotlight | winner
      contestId: null,
      spotlightId: null,
      reveal: {}, // ключ 'total:<pid>' или '<contestId>:<pid>' -> true
      showPlaces: true,
      message: '',
    },
  };
}

function id(prefix = 'x') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

let state = defaultState();

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...defaultState(), ...parsed };
    state.display = { ...defaultState().display, ...(parsed.display || {}) };
    console.log('Состояние загружено из data/state.json');
  } catch {
    console.log('Создаю новое состояние');
    await saveState();
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState().catch(console.error), 300);
}

async function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(tmp, STATE_FILE); // атомарная запись, чтобы файл не бился при выключении
}

// --- SSE: все подключённые окна (экран + пульты) ---
const clients = new Set();

function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 20000).unref();

// --- вспомогательное ---
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveFile(res, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  }
}

// Путь внутри каталога? Защита от выхода наружу через ../
function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return target.startsWith(base) ? target : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  // Поток состояния
  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, state);
  }

  // Пульт присылает состояние целиком — так проще и надёжнее при пересборке списков
  if (pathname === '/api/state' && req.method === 'POST') {
    try {
      const incoming = JSON.parse(await readBody(req));
      state = { ...incoming, rev: (state.rev || 0) + 1 };
      scheduleSave();
      broadcast();
      return sendJson(res, 200, { ok: true, rev: state.rev });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  // Загрузка фото: dataURL -> файл на диске
  if (pathname === '/api/photo' && req.method === 'POST') {
    try {
      const { dataUrl } = JSON.parse(await readBody(req));
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
      if (!m) throw new Error('Ожидается изображение png/jpeg/webp');
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const name = `${id('p')}.${ext}`;
      await fsp.writeFile(path.join(PHOTO_DIR, name), Buffer.from(m[2], 'base64'));
      return sendJson(res, 200, { ok: true, url: `/photos/${name}` });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    state = defaultState();
    scheduleSave();
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname.startsWith('/photos/')) {
    const target = safeJoin(PHOTO_DIR, pathname.slice('/photos'.length));
    if (!target) return sendJson(res, 400, { ok: false });
    return serveFile(res, target);
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = safeJoin(PUBLIC_DIR, rel);
  if (!target) return sendJson(res, 400, { ok: false });
  return serveFile(res, target);
});

await fsp.mkdir(PHOTO_DIR, { recursive: true });
await loadState();

server.listen(PORT, '0.0.0.0', () => {
  const nets = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log('\n  ВОЛШЕБНОЕ ЗЕРКАЛО запущено\n');
  console.log(`  Пульт ведущего:  http://localhost:${PORT}/admin.html`);
  console.log(`  Экран зеркала:   http://localhost:${PORT}/display.html`);
  for (const ip of nets) {
    console.log(`  С телефона/планшета в той же сети: http://${ip}:${PORT}/admin.html`);
  }
  console.log('\n  Остановить: Ctrl+C\n');
});
