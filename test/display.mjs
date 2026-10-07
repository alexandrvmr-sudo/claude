// Автотест экрана зеркала: поднимает сервер, открывает display.html в браузере
// и проверяет счётчик, звук и то, что список участников влезает в экран.
// Запуск: npm test (нужен Chrome/Chromium, путь можно задать в CHROME).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 7789;
const APP = `http://localhost:${APP_PORT}`;
const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-display-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(APP_PORT), MIRROR_DATA: dataDir },
  stdio: 'ignore',
});
for (let i = 0; i < 40; i++) {
  try { await fetch(`${APP}/api/state`); break; } catch { await sleep(250); }
}

// участники и баллы готовим через API — экран должен получить их по SSE
const base = await (await fetch(`${APP}/api/state`)).json();
const people = ['Анна Зорина', 'Борис Ким', 'Вера Лис', 'Глеб Орлов', 'Дина Хан',
  'Егор Шах', 'Жанна Ли', 'Зоя Март', 'Иван Пак', 'Кира Нор', 'Лев Дон', 'Мир Тан'];
base.participants = people.map((name, i) => ({ id: `u${i}`, name, note: 'Город', photo: '', out: false, hidden: false }));
base.scores = Object.fromEntries(base.participants.map((p, i) => [
  p.id, Object.fromEntries(base.contests.map((c, j) => [c.id, 3 + ((i * 5 + j * 3) % 8)])),
]));
base.display = {
  ...base.display,
  mode: 'leaderboard',
  message: 'Проверка',
  reveal: Object.fromEntries(base.participants.map((p) => [`total:${p.id}`, true])),
  sound: { on: true, volume: 0.6, ambient: false, testId: 0 },
  count: { source: 'total', runId: 0, duration: 1200, showBreakdown: false },
};
const post = async (fn) => {
  const st = await (await fetch(`${APP}/api/state`)).json();
  fn(st);
  await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
};
await fetch(`${APP}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base) });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required', // в тесте звук без нажатия клавиши
  `--remote-debugging-port=${CDP_PORT}`, '--window-size=1920,1080', `${APP}/display.html`,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('display.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* браузер ещё поднимается */ }
    await sleep(300);
  }
  throw new Error('страница экрана не открылась');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const waiting = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.text || 'исключение');
  if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
const send = (method, params = {}) => {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((r) => waiting.set(n, r));
};
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await sleep(1500);
await evaluate(`window.__osc = 0;
  const P = window.AudioContext.prototype; const oc = P.createOscillator;
  P.createOscillator = function () { window.__osc += 1; return oc.call(this); };
  MMSound.unlock(); 'ok'`);

const checks = [];
const ok = (name, cond, extra = '') => checks.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

// Ждём нужного состояния, а не фиксированной паузы: в headless кадры идут
// неровно, и жёсткий sleep делал тест капризным.
async function waitFor(expression, want, timeout = 10000) {
  const until = Date.now() + timeout;
  let last;
  do {
    last = await evaluate(expression);
    if (last === want) return last;
    await sleep(120);
  } while (Date.now() < until);
  return last;
}

// 1. двенадцать участников влезают в экран без обрезки
const fit = await evaluate(`(() => {
  const wrap = document.querySelector('.rows');
  const kids = [...wrap.children];
  const gap = parseFloat(getComputedStyle(wrap).rowGap) || 0;
  const need = kids.reduce((s, n) => s + n.offsetHeight, 0) + gap * (kids.length - 1);
  return { rows: kids.length, need: Math.round(need), avail: wrap.clientHeight };
})()`);
ok('все участники влезают в экран', fit.rows === 12 && fit.need <= fit.avail + 1, `${fit.rows} строк, ${fit.need}px из ${fit.avail}px`);

// 2. счётчик стоит на нуле, пока его не запустили
await post((st) => { st.display.mode = 'spotlight'; st.display.spotlightId = 'u0'; st.display.message = ''; });
await sleep(600);
ok('счётчик ждёт на нуле', (await evaluate(`document.querySelector('.counter').textContent`)) === '0');

// 3. запуск: число доезжает до суммы, место появляется после остановки
await evaluate(`window.__osc = 0`);
await post((st) => { st.display.count.runId = 1; });
const total = base.contests.reduce((s, c) => s + base.scores.u0[c.id], 0);
const reached = await waitFor(`document.querySelector('.counter').textContent`, String(total));
ok('счётчик доезжает до суммы', reached === String(total), `на экране ${reached}, ждали ${total}`);
const labelled = await waitFor(`document.querySelector('.counter-label').textContent.includes('место')`, true);
ok('после остановки видно место', labelled === true);
const osc = await evaluate(`window.__osc`);
ok('щелчки и удар звучат', osc >= total, `генераторов ${osc}`);

// 4. сменили участника, а «Начислить» не нажимали: на экране ноль, а не чужая цифра
await post((st) => { st.display.spotlightId = 'u1'; }); // номер запуска прежний
const shown = await waitFor(`document.querySelector('.counter').textContent`, '0', 4000);
await sleep(600); // и дальше сам не поедет
const still = await evaluate(`document.querySelector('.counter').textContent`);
ok('новый участник начинает с нуля', shown === '0' && still === '0', `на экране ${still}`);

// 5. перерисовка во время показа не сбивает результат
const other = base.contests.reduce((s, c) => s + base.scores.u1[c.id], 0);
await post((st) => { st.display.count.runId = 5; });
await waitFor(`document.querySelector('.counter').textContent`, String(other));
await post((st) => { st.display.message = 'Результат принят'; });
await sleep(500);
const afterRedraw = await evaluate(`document.querySelector('.counter').textContent`);
ok('перерисовка не сбивает счётчик', afterRedraw === String(other), `на экране ${afterRedraw}, ждали ${other}`);

// 6. выключенный звук действительно молчит
await post((st) => { st.display.sound.on = false; st.display.count.runId = 6; });
await evaluate(`window.__osc = 0`);
await sleep(1800);
ok('при выключенном звуке тихо', (await evaluate(`window.__osc`)) === 0);

ok('страница без ошибок', pageErrors.length === 0, pageErrors.join(' | '));

console.log(checks.join('\n'));
ws.close();
chrome.kill();
server.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);
