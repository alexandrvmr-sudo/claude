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

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
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

// 2. ставим баллы в таблице
await evaluate(`document.querySelector('.tab[data-tab="scores"]').click()`);
await sleep(200);
await evaluate(`(() => { const vals = [3,5,9, 7,7,7, 10,2,4];
  document.querySelectorAll('#score-table input[type=number]').forEach((inp, i) => {
    inp.value = vals[i]; inp.dispatchEvent(new Event('input', { bubbles: true })); }); })()`);
await sleep(700);
st = await (await fetch(`${APP}/api/state`)).json();
const totals = st.participants.map((p) => st.contests.reduce((s, c) => s + (st.scores[p.id][c.id] || 0), 0));
ok('баллы доходят до сервера', JSON.stringify(totals) === JSON.stringify([17, 21, 16]), totals.join('/'));

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

// шестерых заводим напрямую — проверяем сам турнир, а не форму участников
st = await (await fetch(`${APP}/api/state`)).json();
st.participants = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дина', 'Егор']
  .map((name, i) => ({ id: `t${i}`, name, note: '', photo: '', out: false, hidden: false }));
st.scores = {};
await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
await sleep(400);

await evaluate(`document.querySelector('.tab[data-tab="tournament"]').click()`);
await sleep(300);
await evaluate(`(() => { const c = document.querySelector('#tour-on');
  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(400);
await evaluate(`document.querySelector('#tour-start').click()`);
await sleep(600);

st = await (await fetch(`${APP}/api/state`)).json();
let round = st.tournament.rounds[0];
ok('первый тур — две тройки',
  st.tournament.rounds.length === 1 && round.groups.length === 2
  && round.groups.every((g) => g.members.length === 3),
  round.groups.map((g) => g.members.length).join('+'));
ok('у тура свой конкурс', st.contests.filter((c) => c.roundId === round.id).length === 1);
ok('режим «Сетка тура» появился в эфире',
  await evaluate(`[...document.querySelectorAll('#modes .btn')].some(b => b.textContent === 'Сетка тура')`));

// баллы: в каждой тройке у первых двоих больше
const roundContest = st.contests.find((c) => c.roundId === round.id).id;
st.scores = {};
for (const g of round.groups) {
  g.members.forEach((pid, i) => { st.scores[pid] = { [roundContest]: 10 - i * 3 }; });
}
await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
await sleep(500);

await evaluate(`[...document.querySelectorAll('#tour-current button')].find(b => b.textContent === 'Подвести итоги тура').click()`);
await sleep(600);
st = await (await fetch(`${APP}/api/state`)).json();
round = st.tournament.rounds[0];
const perGroup = round.groups.map((g) => g.members.filter((pid) => round.advancing.includes(pid)).length);
ok('из каждой тройки проходят двое',
  round.finished && round.advancing.length === 4 && perGroup.every((n) => n === 2),
  `прошли ${round.advancing.length}, по группам ${perGroup.join('+')}`);
ok('проходят те, у кого больше баллов',
  round.groups.every((g) => round.advancing.includes(g.members[0]) && round.advancing.includes(g.members[1])));

await evaluate(`[...document.querySelectorAll('#tour-current button')].find(b => b.textContent === 'Сформировать следующий тур').click()`);
await sleep(700);
st = await (await fetch(`${APP}/api/state`)).json();
const final = st.tournament.rounds[1];
ok('четверо прошедших собираются в финал',
  st.tournament.rounds.length === 2 && final && final.groups.length === 1
  && final.groups[0].members.length === 4 && final.name === 'Финал',
  final ? `${final.name}, групп ${final.groups.length}` : 'тура нет');
ok('финал открыт как текущий тур', st.tournament.currentRoundId === final.id);

// 8. за весь прогон страница не выбросила ошибок
ok('страница без ошибок', pageErrors.length === 0, pageErrors.join(' | '));

console.log(checks.join('\n'));
ws.close();
chrome.kill();
server.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);
