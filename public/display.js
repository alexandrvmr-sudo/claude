// Экран зеркала: слушает состояние с сервера и перерисовывает сцену.
const stage = document.getElementById('stage');
const banner = document.getElementById('banner');
const offline = document.getElementById('offline');

let state = null;
let prevReveal = {}; // чтобы подсветить только что открытые баллы
let prevRects = new Map(); // FLIP: позиции строк до перерисовки
let firstRender = true; // на первой отрисовке звуки не играем
let prevMode = null;
let prevTestId = 0;
let newlyRevealed = 0;
const unmute = document.getElementById('unmute');
const PREVIEW = new URLSearchParams(location.search).has('preview'); // окно предпросмотра на пульте — без звука

// искры на фоне
(function sparks() {
  const host = document.getElementById('sparks');
  for (let i = 0; i < 26; i += 1) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = `${Math.random() * 100}%`;
    s.style.top = `${70 + Math.random() * 35}%`;
    s.style.animationDuration = `${9 + Math.random() * 13}s`;
    s.style.animationDelay = `${-Math.random() * 20}s`;
    host.appendChild(s);
  }
})();

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function avatar(p, cls) {
  if (p.photo) {
    const img = el('img', cls);
    img.src = p.photo;
    img.alt = '';
    return img;
  }
  const div = el('div', `${cls} placeholder`, (p.name || '?').trim().charAt(0).toUpperCase());
  return div;
}

function captureRects() {
  prevRects = new Map();
  stage.querySelectorAll('[data-id]').forEach((n) => {
    prevRects.set(n.dataset.id, n.getBoundingClientRect().top);
  });
}

// FLIP: строки плавно переезжают на новые места
function playRects() {
  stage.querySelectorAll('[data-id]').forEach((n) => {
    const before = prevRects.get(n.dataset.id);
    if (before === undefined) return;
    const delta = before - n.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) return;
    n.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
      { duration: 850, easing: 'cubic-bezier(.2,.9,.2,1)' },
    );
  });
}

// Подгоняем содержимое под высоту экрана: уменьшаем базовый кегль блока,
// пока всё не поместится без обрезки. Работает и для списка, и для портрета —
// внутри обоих размеры заданы в em, поэтому высота масштабируется линейно.
function fitBlock() {
  const wrap = stage.querySelector('.rows, .solo, .grid-groups');
  if (!wrap) return;
  // Сбрасываем прошлую подгонку, иначе после переезда окна на экран побольше
  // блок так и остался бы ужатым. Базовый кегль берём из CSS самого блока:
  // у сетки групп он крупнее остальных.
  wrap.style.fontSize = '';
  const base = parseFloat(getComputedStyle(wrap).fontSize);

  const kids = [...wrap.children];
  if (!kids.length) return;
  const style = getComputedStyle(wrap);
  const avail = wrap.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  if (avail <= 0) return;

  // Меряем по габаритам детей: scrollHeight врёт, когда содержимое центрировано
  // и вылезает вверх, а габариты честны и для строк, и для колонок, и для сетки.
  const measure = () => {
    const rects = kids.map((n) => n.getBoundingClientRect());
    return Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top));
  };

  let size = base;
  // сетка групп при сжатии может переложиться, поэтому уточняем в пару заходов
  for (let i = 0; i < 3; i += 1) {
    const need = measure();
    if (need <= avail) break;
    size = Math.max(6, size * (avail / need) - 0.5);
    wrap.style.fontSize = `${size}px`;
  }
}

function rowsView(contestId) {
  const items = MM.ordered(state, contestId);
  const wrap = el('div', 'rows');
  document.body.dataset.count = items.length > 8 ? 'many' : 'few';

  if (!items.length) {
    wrap.appendChild(el('p', 'empty', 'Участники ещё не внесены'));
    return wrap;
  }

  for (const item of items) {
    const { p, revealed, place } = item;
    const row = el('div', 'row');
    row.dataset.id = p.id;
    if (revealed && place === 1) row.classList.add('rank-1');
    if (!revealed) row.classList.add('hidden-score');
    if (p.out) row.classList.add('out');
    if (state.display.spotlightId === p.id) row.classList.add('highlight');

    const placeEl = el('div', 'place', revealed && state.display.showPlaces ? String(place) : '—');
    if (!revealed || !state.display.showPlaces) placeEl.classList.add('unknown');

    const who = el('div', 'who');
    who.appendChild(el('div', 'name', p.name || 'Без имени'));
    if (p.note) who.appendChild(el('div', 'note', p.note));

    const value = contestId ? MM.score(state, p.id, contestId) : MM.total(state, p.id);
    const scoreEl = el('div', 'score');
    if (revealed) {
      scoreEl.textContent = value === null ? '—' : String(value);
      const key = MM.revealKey(contestId, p.id);
      if (!prevReveal[key]) { // только что открыли
        scoreEl.classList.add('revealed');
        newlyRevealed += 1;
      }
    } else {
      scoreEl.textContent = '?';
      scoreEl.classList.add('unknown');
    }

    row.append(placeEl, avatar(p, 'avatar'), who, scoreEl);
    wrap.appendChild(row);
  }
  return wrap;
}

// --- счётчик баллов ---
// Экран сам крутит число от нуля: пульт только присылает новый номер запуска (runId).
const counter = { key: null, runId: 0, raf: 0, el: null, label: null, value: 0, done: false, info: null, ticks: null };

function formatValue(v, target) {
  const decimals = (String(target).split('.')[1] || '').length;
  return decimals ? v.toFixed(decimals) : String(Math.round(v));
}

function paintCounter() {
  if (!counter.el || !counter.info) return;
  counter.el.textContent = formatValue(counter.value, counter.info.target);
  if (!counter.label) return;
  const parts = [counter.info.contest ? counter.info.contest.name : 'баллов'];
  if (counter.done && state.display.showPlaces && !counter.info.contest) {
    parts.push(`${MM.placeOf(state, counter.info.pid)} место`);
  }
  counter.label.textContent = parts.join(' · ');
}

function startCounter(numEl, labelEl, opts) {
  // перерисовка сцены создаёт новые узлы — просто переподключаем к ним текущий счёт
  counter.el = numEl;
  counter.label = labelEl;
  counter.info = opts;

  // «тот же запуск» — это тот же номер И тот же участник И тот же источник баллов,
  // иначе на экране осталась бы цифра предыдущего участника
  const key = `${opts.runId}|${opts.pid}|${opts.contest ? opts.contest.id : 'total'}`;
  if (counter.key === key) {
    if (counter.done) numEl.classList.add('done');
    paintCounter();
    return;
  }

  cancelAnimationFrame(counter.raf);
  if (counter.ticks) counter.ticks.cancel(); // старые щелчки уже расписаны — снимаем
  counter.ticks = null;
  const pressed = opts.runId !== 0 && opts.runId !== counter.runId; // ведущий нажал «Начислить»
  counter.key = key;
  counter.runId = opts.runId;
  counter.value = 0;
  counter.done = false;

  // Крутим только по нажатию. Если сменился участник, а номер запуска прежний,
  // показываем ноль и ждём ведущего — иначе баллы откроются сами.
  if (!pressed) {
    paintCounter();
    return;
  }

  const started = performance.now();
  sound('whoosh');
  counter.ticks = soundCountdown(counter.info.target, counter.info.duration);
  const step = (now) => {
    const t = Math.min(1, (now - started) / Math.max(200, counter.info.duration));
    // замедление к финалу — главный эффект: последние баллы «докапывают» медленно
    counter.value = counter.info.target * (1 - (1 - t) ** 3);
    if (t < 1) {
      paintCounter();
      counter.raf = requestAnimationFrame(step);
    } else {
      counter.value = counter.info.target;
      counter.done = true;
      if (counter.el) counter.el.classList.add('done');
      paintCounter();
      sound('strike');
    }
  };
  counter.raf = requestAnimationFrame(step);
}

// Сетка тура: группы рядом, в каждой свои участники и баллы за тур.
// Баллы закрыты, пока ведущий их не откроет, — как и в обычном рейтинге.
function groupsView(round) {
  const wrap = el('div', 'grid-groups');
  if (!round) {
    wrap.appendChild(el('p', 'empty', 'Тур ещё не сформирован'));
    return wrap;
  }
  wrap.dataset.groups = String(round.groups.length);

  for (const group of round.groups) {
    const card = el('div', 'gcard');
    card.appendChild(el('div', 'gname', group.name));

    const rows = MM.groupStanding(state, round, group).map((r) => ({
      ...r,
      revealed: MM.isRevealed(state, round.id, r.p.id),
    }));
    // нераскрытые уходят вниз в порядке жеребьёвки, чтобы не выдать результат
    rows.sort((a, b) => {
      if (a.revealed !== b.revealed) return a.revealed ? -1 : 1;
      if (a.revealed && b.revealed && a.value !== b.value) return b.value - a.value;
      return a.i - b.i;
    });

    for (const row of rows) {
      const line = el('div', 'gline');
      line.dataset.id = row.p.id;
      const goes = round.finished && row.revealed && row.advances;
      if (goes) line.classList.add('goes');
      if (!row.revealed) line.classList.add('hidden-score');
      if (row.p.out) line.classList.add('out');

      line.appendChild(avatar(row.p, 'gpic'));

      const who = el('div', 'gwho');
      who.appendChild(el('div', 'gnm', row.p.name || 'Без имени'));
      if (goes) who.appendChild(el('div', 'gbadge', 'проходит дальше'));
      else if (row.p.note) who.appendChild(el('div', 'gnote', row.p.note));
      line.appendChild(who);

      const score = el('div', 'gscore');
      if (row.revealed) {
        score.textContent = String(row.value);
        if (!prevReveal[MM.revealKey(round.id, row.p.id)]) {
          score.classList.add('revealed');
          newlyRevealed += 1;
        }
      } else {
        score.textContent = '?';
        score.classList.add('unknown');
      }
      line.appendChild(score);
      card.appendChild(line);
    }
    wrap.appendChild(card);
  }
  return wrap;
}

function soloView(p, { winner = false } = {}) {
  const d = state.display;
  const c = d.count || { source: 'total', runId: 0, duration: 3000, showBreakdown: false };
  const box = el('div', `solo${winner ? ' is-winner' : ''}`);

  // слева портрет, справа имя и баллы
  const frame = el('div', 'portrait-wrap');
  frame.appendChild(avatar(p, 'portrait'));
  if (winner) frame.appendChild(el('div', 'crown', '♛'));

  const info = el('div', 'solo-info');
  info.appendChild(el('div', 'solo-name', p.name || 'Без имени'));
  if (p.note) info.appendChild(el('div', 'solo-note', p.note));
  box.append(frame, info);

  const contest = c.source && c.source !== 'total'
    ? state.contests.find((x) => x.id === c.source)
    : null;
  const target = contest ? (MM.score(state, p.id, contest.id) ?? 0) : MM.total(state, p.id);

  const counterBox = el('div', 'counter-box');
  const num = el('div', 'counter', '0');
  const label = el('div', 'counter-label');
  counterBox.append(num, label);
  info.appendChild(counterBox);
  startCounter(num, label, { runId: c.runId || 0, target, duration: c.duration || 3000, contest, pid: p.id });

  // разбивка по конкурсам — по желанию ведущего, иначе на экране только портрет и число
  if (c.showBreakdown && state.contests.length) {
    const allScores = state.participants.flatMap((q) => state.contests.map((x) => MM.score(state, q.id, x.id) || 0));
    const max = Math.max(1, ...allScores);
    const bd = el('div', 'breakdown');
    for (const x of state.contests) {
      const v = MM.score(state, p.id, x.id);
      const line = el('div', 'bd-row');
      line.appendChild(el('div', 'bd-name', x.name));
      const bar = el('div', 'bd-bar');
      const fill = el('div', 'bd-fill');
      fill.style.width = v === null ? '0%' : `${Math.max(2, (v / max) * 100)}%`;
      bar.appendChild(fill);
      line.append(bar, el('div', 'bd-val', v === null ? '—' : String(v)));
      bd.appendChild(line);
    }
    info.appendChild(bd);
  }

  return box;
}

function render() {
  if (!state) return;
  document.getElementById('title').textContent = state.settings.title || '';
  document.getElementById('subtitle').textContent = state.settings.subtitle || '';

  const d = state.display;
  if (!PREVIEW) MMSound.configure(d.sound);
  newlyRevealed = 0;

  // смена картинки на экране слышна: победителя встречаем фанфарами
  if (!firstRender && d.mode !== prevMode) sound(d.mode === 'winner' ? 'fanfare' : 'whoosh');
  if (!firstRender && (d.sound?.testId || 0) !== prevTestId) sound('strike');
  if (!PREVIEW) MMSound.ambient(d.mode === 'standby' && d.sound?.ambient);

  // подпись внизу ставим до перерисовки сцены: она меняет высоту,
  // а список подгоняется под оставшееся место
  if (d.message) {
    banner.textContent = d.message;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  captureRects();
  stage.innerHTML = '';

  if (d.mode === 'standby') {
    const box = el('div', 'standby');
    box.appendChild(el('div', 'orb'));
    box.appendChild(el('p', null, state.settings.subtitle || 'Зеркало молчит'));
    stage.appendChild(box);
  } else if (d.mode === 'leaderboard') {
    stage.appendChild(el('h2', 'stage-title', 'Общий рейтинг'));
    stage.appendChild(rowsView(null));
  } else if (d.mode === 'groups') {
    const round = MM.currentRound(state);
    stage.appendChild(el('h2', 'stage-title', round ? round.name : 'Турнир'));
    stage.appendChild(groupsView(round));
  } else if (d.mode === 'contest') {
    const c = state.contests.find((x) => x.id === d.contestId) || state.contests[0];
    stage.appendChild(el('h2', 'stage-title', c ? c.name : 'Конкурс'));
    stage.appendChild(rowsView(c ? c.id : null));
  } else if (d.mode === 'spotlight' || d.mode === 'winner') {
    const p = state.participants.find((x) => x.id === d.spotlightId);
    if (!p) {
      stage.appendChild(el('p', 'empty', 'Участник не выбран'));
    } else {
      if (d.mode === 'winner') stage.appendChild(el('h2', 'stage-title', 'Победитель'));
      stage.appendChild(soloView(p, { winner: d.mode === 'winner' }));
    }
  }

  fitBlock();
  playRects();

  if (newlyRevealed) sound('reveal');
  updateUnmuteHint();

  prevReveal = { ...d.reveal };
  prevMode = d.mode;
  prevTestId = d.sound?.testId || 0;
  firstRender = false;
}

// Окно сменило размер (например, переехало на телевизор) или дозагрузился шрифт —
// пересчитываем посадку: от этого зависят высоты строк.
addEventListener('resize', fitBlock);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitBlock);

// --- звук ---
// Браузер запрещает звук до первого действия пользователя: ловим любое
// нажатие и показываем подсказку, пока звук не разрешён.
function sound(name, arg) {
  if (PREVIEW || firstRender) return;
  MMSound.play(name, arg);
}

function soundCountdown(target, duration) {
  if (PREVIEW || firstRender) return null;
  return MMSound.countdown(target, duration);
}

function updateUnmuteHint() {
  const want = !PREVIEW && state && state.display.sound && state.display.sound.on !== false;
  unmute.hidden = !(want && !MMSound.ready());
}

for (const ev of ['keydown', 'pointerdown', 'click']) {
  addEventListener(ev, () => {
    if (PREVIEW) return;
    MMSound.unlock();
    updateUnmuteHint();
  });
}

// --- связь с сервером ---
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (ev) => {
    offline.hidden = true;
    state = JSON.parse(ev.data);
    render();
  });
  es.onerror = () => {
    offline.hidden = false;
    // EventSource переподключается сам, помогаем только при полном закрытии
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 1500);
  };
}
connect();

// F — на весь экран (на телевизоре удобно с беспроводной мыши/клавиатуры)
addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f' || e.key === 'F11') {
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});
