// Автотест пульта: поднимает сервер на отдельном порту, открывает пульт
// в браузере и проверяет, что участники, баллы и открытие оценок работают.
// Запуск: npm test (нужен Chrome/Chromium, путь можно задать в CHROME).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 7788;
const APP = `http://localhost:${APP_PORT}`;
const CHROME = process.env.CHROME || [
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.log('Пропуск: не найден Chrome/Chromium (укажите путь в переменной CHROME)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checksEarly = [];

// отдельный каталог данных, чтобы не затереть настоящее шоу
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-test-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(APP_PORT), MIRROR_DATA: dataDir },
  stdio: 'ignore',
});
for (let i = 0; i < 40; i++) {
  try { await fetch(`${APP}/api/state`); break; } catch { await sleep(250); }
}


const PORT = 9333;
// Отсутствие программы-открывалки не должно ронять уже поднятый сервер
{
  const port = APP_PORT + 20;
  const probe = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MIRROR_DATA: dataDir,
      MIRROR_FORCE_OPEN: '1',
      PATH: '/nonexistent', // открывалки точно нет
    },
    stdio: 'ignore',
  });
  let alive = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    try {
      alive = (await (await fetch(`http://localhost:${port}/api/state`)).json()) !== null;
      if (alive) break;
    } catch { /* ещё поднимается */ }
  }
  await sleep(600); // падает он обычно сразу после старта
  let stillAlive = false;
  try { stillAlive = !!(await (await fetch(`http://localhost:${port}/api/state`)).json()); } catch { /* упал */ }
  checksEarly.push(`${stillAlive ? 'OK  ' : 'FAIL'} сервер живёт, даже если браузер открыть нечем`);
  probe.kill();
}

// Свой профиль браузера на каждый прогон: иначе Chromium подхватывает
// уже открытую вкладку прошлого запуска вместе с её состоянием.
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', `${APP}/admin.html`,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('admin.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error('страница не открылась');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const waiting = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.text || 'исключение');
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
function send(method, params = {}) {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((r) => waiting.set(n, r));
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
}

await send('Runtime.enable'); // чтобы ловить ошибки на странице
await sleep(1200);
// окна подтверждения и ввода в тесте отвечаем сами
await evaluate(`window.confirm = () => true;
  window.__promptAnswer = '';
  window.prompt = () => window.__promptAnswer; 'ok'`);

const checks = [...checksEarly];
let st;
const ok = (name, cond, extra = '') => checks.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// 0. библиотека шоу: создаём шоу, в него и пойдут участники
await evaluate(`(() => { const f = document.querySelector('#add-show');
  f.name.value = 'Съёмка 12 мая'; f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); })()`);
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('шоу создаётся и открывается', st.showName === 'Съёмка 12 мая', st.showName);
ok('название видно в шапке', (await evaluate(`document.querySelector('#brand-show').textContent`)) === 'Съёмка 12 мая');

await evaluate(`document.querySelector('.tab[data-tab="people"]').click()`);
await sleep(200);

// 1. добавляем трёх участников через форму
for (const [name, note] of [['Анна Зорина', 'Тверь'], ['Борис Ким', 'Омск'], ['Вера Лис', 'Пермь']]) {
  await evaluate(`(() => { const f = document.querySelector('#add-person');
    f.name.value = ${JSON.stringify(name)}; f.note.value = ${JSON.stringify(note)};
    f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); })()`);
  await sleep(250);
}
st = await (await fetch(`${APP}/api/state`)).json();
ok('форма добавляет участников', st.participants.length === 3, `их ${st.participants.length}`);
ok('подпись сохраняется', st.participants[0].note === 'Тверь');

// 2. баллы: ставим через API (формы начисления проверяются ниже, по типам конкурсов)
st = await (await fetch(`${APP}/api/state`)).json();
const cids = st.contests.map((c) => c.id);
st.scores = {
  [st.participants[0].id]: { [cids[0]]: 3, [cids[1]]: 5, [cids[2]]: 9 },
  [st.participants[1].id]: { [cids[0]]: 7, [cids[1]]: 7, [cids[2]]: 7 },
  [st.participants[2].id]: { [cids[0]]: 10, [cids[1]]: 2, [cids[2]]: 4 },
};
await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
const totals = st.participants.map((p) => st.contests.reduce((sum, c) => sum + ((st.scores[p.id] || {})[c.id] || 0), 0));
ok('баллы доходят до сервера', JSON.stringify(totals) === JSON.stringify([17, 21, 16]), totals.join('/'));
await evaluate(`document.querySelector('.tab[data-tab="scores"]').click()`);
await sleep(300);
ok('общий зачёт показывает суммы',
  (await evaluate(`[...document.querySelectorAll('#score-table tr')].slice(1).map(r => r.cells[r.cells.length-1].textContent).join('/')`)) === '17/21/16');

// 3. открываем по одному — должен идти с последнего места
await evaluate(`document.querySelector('.tab[data-tab="show"]').click()`);
await sleep(200);
await evaluate(`document.querySelector('#reveal-next').click()`);
await sleep(350);
st = await (await fetch(`${APP}/api/state`)).json();
const openedFirst = Object.keys(st.display.reveal);
const lastPlaceId = st.participants[2].id; // Вера Лис, 16 баллов
ok('первым открывается последнее место', openedFirst.length === 1 && openedFirst[0] === `total:${lastPlaceId}`, openedFirst.join(','));

// 4. пробел открывает следующего
await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`);
await sleep(350);
st = await (await fetch(`${APP}/api/state`)).json();
ok('пробел открывает следующего', Object.keys(st.display.reveal).length === 2, String(Object.keys(st.display.reveal).length));

// 5. «открыть всех» и смена режима
await evaluate(`document.querySelector('#reveal-all').click()`);
await sleep(300);
await evaluate(`[...document.querySelectorAll('#modes .btn')].find(b => b.textContent === 'Победитель').click()`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('открываются все', Object.keys(st.display.reveal).length === 3);
ok('режим «Победитель» ставится', st.display.mode === 'winner', st.display.mode);
ok('победитель выбран автоматически', st.display.spotlightId === st.participants[1].id, 'Борис Ким ждали');

// 6. начисление баллов на портрете участника
await evaluate(`[...document.querySelectorAll('#modes .btn')].find(b => b.textContent === 'Один участник').click()`);
await sleep(300);
await evaluate(`(() => { const s = document.querySelector('#mode-person');
  s.value = [...s.options].find(o => o.textContent === 'Анна Зорина').value;
  s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('счётчик виден в режиме портрета', await evaluate(`!document.querySelector('#count-box').hidden`));
ok('смена участника сбрасывает счёт', st.display.count.runId === 0);

await evaluate(`document.querySelector('#count-run').click()`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('кнопка запускает начисление', st.display.count.runId === 1, `runId=${st.display.count.runId}`);

await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('пробел повторяет начисление', st.display.count.runId === 2, `runId=${st.display.count.runId}`);

await evaluate(`(() => { const s = document.querySelector('#count-source');
  s.value = [...s.options][1].value; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('смена источника баллов сбрасывает счёт', st.display.count.runId === 0 && st.display.count.source !== 'total');

await evaluate(`document.querySelector('#count-reset').click()`);
await sleep(250);
st = await (await fetch(`${APP}/api/state`)).json();
ok('кнопка «вернуть на 0» работает', st.display.count.runId === 0);


// 6b. второе шоу и возврат к первому
await evaluate(`document.querySelector('.tab[data-tab="shows"]').click()`);
await sleep(300);
await evaluate(`(() => { const f = document.querySelector('#add-show');
  f.name.value = 'Финал'; f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); })()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
ok('новое шоу начинается пустым', st.showName === 'Финал' && st.participants.length === 0,
  `${st.showName}, участников ${st.participants.length}`);

const shows = (await (await fetch(`${APP}/api/shows`)).json()).shows;
const first = shows.find((x) => x.name === 'Съёмка 12 мая');
ok('первое шоу сохранило участников', first && first.participants === 3, `участников ${first && first.participants}`);

await evaluate(`[...document.querySelectorAll('#shows .show-row')]
  .find(r => r.textContent.includes('Съёмка 12 мая'))
  .querySelector('button').click()`);
await sleep(700);
st = await (await fetch(`${APP}/api/state`)).json();
ok('шоу открывается обратно с участниками',
  st.showName === 'Съёмка 12 мая' && st.participants.length === 3 && st.participants[0].name === 'Анна Зорина',
  `${st.showName}, участников ${st.participants.length}`);
ok('эфир при открытии сбрасывается', st.display.mode === 'standby' && Object.keys(st.display.reveal).length === 0);

// переключение шоу сразу после правки не теряет её (запись на диск отложенная)
st = await (await fetch(`${APP}/api/state`)).json();
st.participants.push({ id: 'late', name: 'Поздний Гость', note: '', photo: '', out: false, hidden: false });
const beforeId = st.showId;
await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
await fetch(`${APP}/api/shows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Проверка переключения' }) });
await fetch(`${APP}/api/shows/${beforeId}/open`, { method: 'POST' });
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('правка перед переключением шоу не теряется',
  st.participants.some((p) => p.id === 'late'), `участников ${st.participants.length}`);

// 7. управление звуком
await evaluate(`document.querySelector('.tab[data-tab="settings"]').click()`);
await sleep(200);
await evaluate(`(() => { const i = document.querySelector('#sound-volume');
  i.value = '40'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
ok('громкость доходит до экрана', Math.abs(st.display.sound.volume - 0.4) < 0.01, String(st.display.sound.volume));

await evaluate(`document.querySelector('#sound-test').click()`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('кнопка проверки звука шлёт сигнал', st.display.sound.testId === 1, `testId=${st.display.sound.testId}`);

await evaluate(`document.querySelector('#mute-toggle').click()`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('быстрое выключение звука работает', st.display.sound.on === false);
await evaluate(`document.querySelector('#mute-toggle').click()`);
await sleep(300);
st = await (await fetch(`${APP}/api/state`)).json();
ok('и обратное включение тоже', st.display.sound.on === true);

// 7b. турнир: тройки -> по двое дальше -> финал
await evaluate(`document.querySelector('.tab[data-tab="shows"]').click()`);
await sleep(300);
await evaluate(`(() => { const f = document.querySelector('#add-show');
  f.name.value = 'Турнир'; f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); })()`);
await sleep(600);

// --- жеребьёвка и типы конкурсов ---
// десять участников заводим напрямую: проверяем механику, а не форму
st = await (await fetch(`${APP}/api/state`)).json();
st.participants = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дина', 'Егор', 'Жанна', 'Зоя', 'Иван', 'Кира']
  .map((name, i) => ({ id: `t${i}`, name, note: '', photo: '', out: false, hidden: false }));
st.scores = {};
st.marks = {};
await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
await sleep(400);

await evaluate(`document.querySelector('.tab[data-tab="draw"]').click()`);
await sleep(300);
await evaluate(`document.querySelector('#draw-groups').click()`);
await sleep(700);
st = await (await fetch(`${APP}/api/state`)).json();
const sizes = st.draw.groups.map((g) => g.length).sort();
ok('десять человек делятся на тройки',
  st.draw.groups.length === 3 && sizes.join('+') === '3+3+4'
  && new Set(st.draw.groups.flat()).size === 10,
  sizes.join('+'));
ok('жеребьёвка сразу уходит на экран', st.display.mode === 'draw' && st.draw.runId > 0);

await evaluate(`document.querySelector('#draw-order').click()`);
await sleep(700);
st = await (await fetch(`${APP}/api/state`)).json();
ok('очередь — все участники по одному разу',
  st.draw.kind === 'order' && new Set(st.draw.order).size === 10, `${st.draw.order.length}`);

// финал: двое лидеров не попадают в розыгрыш
st.scores = { t3: { [st.contests[0].id]: 60 }, t7: { [st.contests[0].id]: 50 } };
await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
await sleep(400);
await evaluate(`document.querySelector('#final-top').click()`);
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('в финал берём двух лидеров', st.draw.finalists.join(',') === 't3,t7', st.draw.finalists.join(','));

await evaluate(`document.querySelector('#final-call-a').click()`);
await sleep(500);
await evaluate(`document.querySelector('#final-call-b').click()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
const calls = st.draw.calls || [];
ok('к каждому финалисту вышло по одному',
  calls.length === 2 && calls[0].finalist === 't3' && calls[1].finalist === 't7',
  calls.map((c) => `${c.finalist}->${c.guest}`).join(' '));
ok('финалисты сами не выпадают',
  calls.every((c) => !st.draw.finalists.includes(c.guest)) && calls[0].guest !== calls[1].guest);

// начисление по типам конкурсов
await evaluate(`document.querySelector('.tab[data-tab="scores"]').click()`);
await sleep(400);
const pickContest = async (name) => {
  await evaluate(`(() => { const sel = document.querySelector('#score-contest');
    sel.value = [...sel.options].find((o) => o.textContent.startsWith('${name}')).value;
    sel.dispatchEvent(new Event('change')); return 'ok'; })()`);
  await sleep(400);
};
const clickOn = async (index, label) => {
  await evaluate(`(() => { const card = document.querySelectorAll('#score-cards .score-card')[${index}];
    [...card.querySelectorAll('button')].find((b) => b.textContent.startsWith('${label}')).click();
    return 'ok'; })()`);
  await sleep(450);
};

await pickContest('Чёрный ящик');
ok('у чёрного ящика своя форма начисления',
  /Что это \+30/.test(await evaluate(`document.querySelector('#score-kind').textContent`)));
for (const label of ['Живое', 'Цвет', 'Что это', 'Рискнул']) await clickOn(0, label);
st = await (await fetch(`${APP}/api/state`)).json();
const boxId = st.contests.find((c) => c.kind === 'blackbox').id;
ok('чёрный ящик складывает баллы', st.scores.t0[boxId] === 60, String(st.scores.t0[boxId]));

await pickContest('Стаканы');
await clickOn(1, 'Отравленный');
st = await (await fetch(`${APP}/api/state`)).json();
const glassId = st.contests.find((c) => c.kind === 'glasses').id;
ok('отравленный стакан уводит в минус', st.scores.t1[glassId] === -10, String(st.scores.t1[glassId]));

await pickContest('Книжный червь');
await clickOn(2, 'Пустая книга');
await clickOn(2, 'Нашёл 50');
st = await (await fetch(`${APP}/api/state`)).json();
const bookId = st.contests.find((c) => c.kind === 'books').id;
ok('пустая книга плюс находка', st.scores.t2[bookId] === 60, String(st.scores.t2[bookId]));

await pickContest('Блиц');
await clickOn(3, '+10');
await clickOn(3, '+10');
st = await (await fetch(`${APP}/api/state`)).json();
const blitzId = st.contests.find((c) => c.kind === 'blitz').id;
ok('блиц считает правильные ответы', st.scores.t3[blitzId] === 20, String(st.scores.t3[blitzId]));

await clickOn(3, 'Сброс');
st = await (await fetch(`${APP}/api/state`)).json();
ok('сброс убирает баллы', st.scores.t3[blitzId] === null, String(st.scores.t3[blitzId]));

// штрафные задания «Стаканов»
await evaluate(`document.querySelector('.tab[data-tab="contests"]').click()`);
await sleep(300);
await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.contest-card')];
  const card = cards.find((c) => c.querySelector('select.kind-select').value === 'glasses');
  const area = card.querySelectorAll('textarea')[1];
  area.value = 'Станцуй под детскую песню\\nСкажи три странных комплимента';
  area.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
const glasses = st.contests.find((c) => c.kind === 'glasses');
ok('штрафные задания сохраняются',
  (glasses.penalties || []).length === 2 && glasses.penalties[0] === 'Станцуй под детскую песню',
  `заданий ${(glasses.penalties || []).length}`);

await evaluate(`document.querySelector('.tab[data-tab="scores"]').click()`);
await sleep(300);
await pickContest('Стаканы');
ok('у «Стаканов» появляется окно штрафа', (await evaluate(`!document.querySelector('#penalty-box').hidden`)) === true);

await evaluate(`(() => { const sel = document.querySelector('#penalty-who');
  sel.value = 'Борис'; sel.dispatchEvent(new Event('change')); return 'ok'; })()`);
await sleep(400);
await evaluate(`document.querySelector('#penalty-draw').click()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
ok('штраф уходит на экран с именем',
  st.display.mode === 'penalty' && st.display.penalty.contestId === glasses.id
  && st.display.penalty.who === 'Борис',
  `${st.display.mode}, кому «${st.display.penalty.who}»`);

const firstPenalty = st.display.penalty.index;
await evaluate(`document.querySelector('#penalty-next').click()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
ok('кнопка «другое задание» листает', st.display.penalty.index !== firstPenalty,
  `было ${firstPenalty}, стало ${st.display.penalty.index}`);

const defaults = await (await fetch(`${APP}/api/penalties/default`)).json();
ok('заготовки штрафных заданий на месте', defaults.ok && defaults.list.length === 3,
  `${defaults.list.length} шт.`);

// блиц: список вопросов и ведение
await evaluate(`document.querySelector('.tab[data-tab="contests"]').click()`);
await sleep(300);
await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.contest-card')];
  const card = cards.find((c) => c.querySelector('select.kind-select').value === 'blitz');
  const area = card.querySelectorAll('textarea')[1];
  area.value = 'Кто пришёл на Хеллоуин в костюме бревна? | Аделя\\nКто носит трусы с акулами? | Никита';
  area.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
const blitz = st.contests.find((c) => c.kind === 'blitz');
ok('вопросы блица сохраняются',
  (blitz.questions || []).length === 2 && blitz.questions[0].a === 'Аделя',
  `вопросов ${(blitz.questions || []).length}`);

await evaluate(`document.querySelector('.tab[data-tab="scores"]').click()`);
await sleep(300);
await pickContest('Блиц');
ok('в блице появляется окно ведения', (await evaluate(`!document.querySelector('#quiz-box').hidden`)) === true);
ok('виден первый вопрос',
  (await evaluate(`document.querySelector('#quiz-q').textContent`)).startsWith('Кто пришёл на Хеллоуин'));
ok('ответ закрыт', (await evaluate(`document.querySelector('#quiz-a').textContent`)) === 'Ответ скрыт');

await evaluate(`document.querySelector('#quiz-screen').click()`);
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('вопрос уходит на экран',
  st.display.mode === 'quiz' && st.display.quiz.contestId === blitz.id && st.display.quiz.index === 0);

await evaluate(`document.querySelector('#quiz-answer').click()`);
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('ответ открывается по кнопке', st.display.quiz.revealed === true);
ok('ответ виден и в пульте', (await evaluate(`document.querySelector('#quiz-a').textContent`)) === 'Аделя');

await evaluate(`document.querySelector('#quiz-next').click()`);
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('следующий вопрос снова прячет ответ',
  st.display.quiz.index === 1 && st.display.quiz.revealed === false,
  `вопрос ${st.display.quiz.index + 1}`);


// 8. предсказания: случайное вытягивание и учёт использованных
await evaluate(`document.querySelector('[data-tab="prophecy"]').click()`);
await sleep(300);
const listed = await evaluate(`document.querySelector('#prophecy-list').value.split('\\n').filter(Boolean).length`);
ok('список предсказаний заполнен заготовками', listed >= 20, `${listed} шт.`);

await evaluate(`document.querySelector('#prophecy-who').value = 'Ирина';
  document.querySelector('#prophecy-draw').click(); 'ok'`);
await sleep(1500);
st = await (await fetch(`${APP}/api/state`)).json();
const drawn = st.display.prophecy || {};
ok('предсказание вытянулось и попало на экран',
  st.display.mode === 'prophecy' && !!drawn.text && drawn.who === 'Ирина',
  drawn.text ? `«${drawn.text.slice(0, 40)}…»` : 'пусто');
ok('вытянутое записано как использованное', st.prophecies.used.includes(drawn.text));

// второй раз выпадет другое: уже показанные не повторяются
await evaluate(`document.querySelector('#prophecy-draw').click()`);
await sleep(1500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('второе предсказание другое', st.display.prophecy.text !== drawn.text && st.prophecies.used.length === 2,
  `использовано ${st.prophecies.used.length}`);

await evaluate(`document.querySelector('#prophecy-reset').click()`);
await sleep(400);
st = await (await fetch(`${APP}/api/state`)).json();
ok('сброс использованных работает', st.prophecies.used.length === 0);

// свой список предсказаний сохраняется
await evaluate(`(() => {
  const area = document.querySelector('#prophecy-list');
  area.value = 'Первое своё\\nВторое своё';
  document.querySelector('#prophecy-save').click(); return 'ok';
})()`);
await sleep(500);
st = await (await fetch(`${APP}/api/state`)).json();
ok('свой список предсказаний сохраняется',
  st.prophecies.list.length === 2 && st.prophecies.list[0] === 'Первое своё');

// 9. за весь прогон страница не выбросила ошибок
ok('страница без ошибок', pageErrors.length === 0, pageErrors.join(' | '));

console.log(checks.join('\n'));
ws.close();
chrome.kill();
server.kill();
// сервер мог записать файл уже после kill — не роняем тест из-за уборки
for (const dir of [dataDir, profileDir]) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* останется в /tmp */ }
}
process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);
