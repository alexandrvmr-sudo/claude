// Волшебное зеркало — локальный сервер.
// Отдаёт пульт и экран, хранит текущее состояние и библиотеку сохранённых шоу,
// рассылает изменения всем открытым окнам через SSE.
//
// Можно запустить напрямую (node server.js) или подключить из приложения:
//   import { startServer } from './server.js'
//   const { port, close } = await startServer({ dataDir, port })

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

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
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function id(prefix = 'x') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// Содержимое шоу — то, что готовится заранее и сохраняется в библиотеку.
function defaultShow() {
  return {
    settings: { title: 'Битва сильнейших', subtitle: 'Волшебное зеркало' },
    contests: [
      { id: id('c'), name: 'Испытание 1' },
      { id: id('c'), name: 'Испытание 2' },
      { id: id('c'), name: 'Испытание 3' },
    ],
    participants: [],
    scores: {}, // scores[participantId][contestId] = число или null
    // Турнир: участники сражаются группами, из каждой группы проходят лучшие.
    // Конкурсы тура помечены roundId, вне турнира это поле пустое.
    tournament: {
      on: false,
      groupSize: 3, // по сколько человек в группе
      advance: 2, // сколько проходит дальше из каждой группы
      rounds: [], // [{ id, name, groups: [{id, name, members: [pid]}], advancing: [pid], finished }]
      currentRoundId: null,
    },
  };
}

// Состояние эфира — что прямо сейчас на телевизоре. В библиотеке не хранится.
function defaultDisplay() {
  return {
    mode: 'standby', // standby | leaderboard | contest | spotlight | winner
    contestId: null,
    spotlightId: null,
    reveal: {}, // ключ 'total:<pid>' или '<contestId>:<pid>' -> true
    showPlaces: true,
    message: '',
    sound: {
      on: true,
      volume: 0.7,
      testId: 0, // пульт увеличивает — экран проигрывает пробный звук
      // музыка на экране ожидания, файл public/music/standby.mp3
      music: { on: true, volume: 0.6 },
    },
    // режим «объявление результата»: баллы накручиваются от нуля
    count: {
      source: 'total', // 'total' или id конкурса
      runId: 0, // каждое нажатие «Начислить» увеличивает номер — экран запускает анимацию
      duration: 3000,
      showBreakdown: false,
    },
  };
}

function defaultState() {
  return {
    rev: 0,
    showId: null, // какое шоу из библиотеки открыто
    showName: '',
    ...defaultShow(),
    display: defaultDisplay(),
  };
}

export async function startServer({ dataDir, port, host } = {}) {
  const DATA_DIR = dataDir || process.env.MIRROR_DATA || path.join(ROOT, 'data');
  const PHOTO_DIR = path.join(DATA_DIR, 'photos');
  const SHOWS_DIR = path.join(DATA_DIR, 'shows');
  const STATE_FILE = path.join(DATA_DIR, 'state.json');
  // 0 — это «любой свободный порт», поэтому проверяем именно на отсутствие значения
  const PORT = port === undefined || port === null
    ? (Number(process.env.PORT) || 7777)
    : Number(port);
  const HOST = host || '0.0.0.0'; // чтобы пульт открывался и с телефона в той же сети

  await fsp.mkdir(PHOTO_DIR, { recursive: true });
  await fsp.mkdir(SHOWS_DIR, { recursive: true });

  let state = defaultState();

  // --- сохранение текущего состояния ---
  let saveTimer = null;
  const writeJson = (file, value) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file); // атомарная запись, чтобы файл не бился при выключении
  };

  function saveNow() {
    clearTimeout(saveTimer);
    writeJson(STATE_FILE, state);
    if (state.showId) saveShowFile(state.showId);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        saveNow();
      } catch (e) {
        console.error('Не удалось сохранить:', e.message);
      }
    }, 300);
  }

  // --- библиотека шоу ---
  const showFile = (showId) => path.join(SHOWS_DIR, `${showId}.json`);

  function showFromState() {
    return {
      settings: state.settings,
      contests: state.contests,
      participants: state.participants,
      scores: state.scores,
      tournament: state.tournament,
    };
  }

  function saveShowFile(showId, name = state.showName) {
    writeJson(showFile(showId), {
      id: showId,
      name: name || 'Без названия',
      updatedAt: new Date().toISOString(),
      show: showFromState(),
    });
  }

  async function readShow(showId) {
    const raw = await fsp.readFile(showFile(showId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.show) throw new Error('Файл шоу испорчен');
    return parsed;
  }

  async function listShows() {
    const files = (await fsp.readdir(SHOWS_DIR)).filter((f) => f.endsWith('.json'));
    const items = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(SHOWS_DIR, f), 'utf8'));
        items.push({
          id: parsed.id,
          name: parsed.name,
          updatedAt: parsed.updatedAt,
          participants: (parsed.show.participants || []).length,
          contests: (parsed.show.contests || []).length,
        });
      } catch { /* битый файл просто не показываем */ }
    }
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items;
  }

  // Открыть шоу: содержимое берём из файла, эфир начинаем с чистого листа,
  // настройки звука — это настройка техники, а не шоу, поэтому остаются.
  function openShow(parsed) {
    const sound = state.display.sound;
    const base = defaultShow();
    state = {
      rev: (state.rev || 0) + 1,
      showId: parsed.id,
      showName: parsed.name,
      ...base,
      ...parsed.show,
      // шоу, сохранённые до появления турнира, не знают про это поле
      tournament: { ...base.tournament, ...(parsed.show.tournament || {}) },
      display: { ...defaultDisplay(), sound },
    };
  }

  async function loadState() {
    try {
      const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
      const base = defaultState();
      state = { ...base, ...parsed };
      state.display = { ...base.display, ...(parsed.display || {}) };
      state.display.count = { ...base.display.count, ...(parsed.display?.count || {}) };
      state.display.sound = { ...base.display.sound, ...(parsed.display?.sound || {}) };
      state.display.sound.music = { ...base.display.sound.music, ...(parsed.display?.sound?.music || {}) };
      state.tournament = { ...base.tournament, ...(parsed.tournament || {}) };
      console.log('Состояние загружено');
    } catch {
      console.log('Создаю новое состояние');
      saveNow();
    }
  }
  await loadState();

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

  const ping = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 20000);
  ping.unref();

  // --- вспомогательное ---
  function sendJson(res, code, obj) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
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

  // Отдаём файл целиком или куском. Куски нужны звуку и видео: без них
  // браузер не умеет перематывать и спотыкается на зацикливании.
  async function serveFile(res, filePath, range) {
    try {
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const stat = await fsp.stat(filePath);
      const m = /^bytes=(\d*)-(\d*)$/.exec(range || '');

      if (m && stat.size) {
        let start = m[1] === '' ? stat.size - Number(m[2]) : Number(m[1]);
        let end = m[1] === '' || m[2] === '' ? stat.size - 1 : Number(m[2]);
        start = Math.max(0, Math.min(start, stat.size - 1));
        end = Math.max(start, Math.min(end, stat.size - 1));
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }

      const data = await fsp.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Accept-Ranges': 'bytes',
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

    // --- библиотека шоу ---
    if (pathname === '/api/shows' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, shows: await listShows(), current: state.showId });
    }

    // Новое шоу: пустое или копия текущего («Сохранить как»)
    if (pathname === '/api/shows' && req.method === 'POST') {
      try {
        const { name, from } = JSON.parse(await readBody(req) || '{}');
        // дописываем текущее шоу до переключения, иначе последние правки пропадут
        if (state.showId) saveNow();
        const newId = id('show');
        const title = (name || '').trim() || 'Новое шоу';
        if (from === 'current') {
          state.showId = newId;
          state.showName = title;
          saveShowFile(newId, title);
        } else {
          const sound = state.display.sound;
          state = {
            rev: (state.rev || 0) + 1,
            showId: newId,
            showName: title,
            ...defaultShow(),
            display: { ...defaultDisplay(), sound },
          };
          saveShowFile(newId, title);
        }
        scheduleSave();
        broadcast();
        return sendJson(res, 200, { ok: true, id: newId });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
    }

    const showMatch = /^\/api\/shows\/([A-Za-z0-9_]+)(\/open|\/copy)?$/.exec(pathname);
    if (showMatch) {
      const showId = showMatch[1];
      const action = showMatch[2];
      try {
        if (action === '/open' && req.method === 'POST') {
          const parsed = await readShow(showId);
          if (state.showId && state.showId !== showId) saveNow(); // не теряем то, что набрали
          openShow(parsed);
          scheduleSave();
          broadcast();
          return sendJson(res, 200, { ok: true, name: state.showName });
        }
        if (action === '/copy' && req.method === 'POST') {
          const parsed = await readShow(showId);
          const newId = id('show');
          writeJson(showFile(newId), {
            id: newId,
            name: `${parsed.name} — копия`,
            updatedAt: new Date().toISOString(),
            show: parsed.show,
          });
          return sendJson(res, 200, { ok: true, id: newId });
        }
        if (!action && req.method === 'PATCH') { // переименование
          const { name } = JSON.parse(await readBody(req) || '{}');
          const parsed = await readShow(showId);
          const title = (name || '').trim() || parsed.name;
          writeJson(showFile(showId), { ...parsed, name: title, updatedAt: new Date().toISOString() });
          if (state.showId === showId) {
            state.showName = title;
            state.rev += 1;
            broadcast();
          }
          return sendJson(res, 200, { ok: true });
        }
        if (!action && req.method === 'DELETE') {
          await fsp.unlink(showFile(showId));
          if (state.showId === showId) {
            state.showId = null;
            state.showName = '';
            state.rev += 1;
            scheduleSave();
            broadcast();
          }
          return sendJson(res, 200, { ok: true });
        }
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

    // Очистить текущее шоу, не трогая библиотеку
    if (pathname === '/api/reset' && req.method === 'POST') {
      const sound = state.display.sound;
      state = {
        ...defaultState(),
        rev: (state.rev || 0) + 1,
        showId: state.showId,
        showName: state.showName,
        display: { ...defaultDisplay(), sound },
      };
      scheduleSave();
      broadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/photos/')) {
      const target = safeJoin(PHOTO_DIR, pathname.slice('/photos'.length));
      if (!target) return sendJson(res, 400, { ok: false });
      return serveFile(res, target, req.headers.range);
    }

    const rel = pathname === '/' ? '/index.html' : pathname;
    const target = safeJoin(PUBLIC_DIR, rel);
    if (!target) return sendJson(res, 400, { ok: false });
    return serveFile(res, target, req.headers.range);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  const boundPort = server.address().port; // при PORT=0 система выдаёт свободный

  return {
    port: boundPort,
    dataDir: DATA_DIR,
    saveNow,
    close: () => new Promise((resolve) => {
      clearInterval(ping);
      for (const res of clients) res.end();
      server.close(resolve);
    }),
  };
}

// Запуск из терминала
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  const nets = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log('\n  ВОЛШЕБНОЕ ЗЕРКАЛО запущено\n');
  console.log(`  Пульт ведущего:  http://localhost:${app.port}/admin.html`);
  console.log(`  Экран зеркала:   http://localhost:${app.port}/display.html`);
  for (const ip of nets) {
    console.log(`  С телефона/планшета в той же сети: http://${ip}:${app.port}/admin.html`);
  }
  console.log('\n  Остановить: Ctrl+C\n');

  // Терминал закрыли — дописываем последние правки, чтобы ничего не потерялось
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try {
        app.saveNow();
      } catch (e) {
        console.error('Не удалось сохранить состояние:', e.message);
      }
      process.exit(0);
    });
  }
}
