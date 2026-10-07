// Экран зеркала: слушает состояние с сервера и перерисовывает сцену.
const stage = document.getElementById('stage');
const banner = document.getElementById('banner');
const offline = document.getElementById('offline');

let state = null;
let prevReveal = {}; // чтобы подсветить только что открытые баллы
let prevRects = new Map(); // FLIP: позиции строк до перерисовки

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
  stage.querySelectorAll('.row[data-id]').forEach((n) => {
    prevRects.set(n.dataset.id, n.getBoundingClientRect().top);
  });
}

// FLIP: строки плавно переезжают на новые места
function playRects() {
  stage.querySelectorAll('.row[data-id]').forEach((n) => {
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

// Подгоняем список под высоту экрана: уменьшаем базовый кегль блока,
// пока все участники не поместятся без прокрутки.
function fitRows() {
  const wrap = stage.querySelector('.rows');
  if (!wrap) return;
  const base = parseFloat(getComputedStyle(document.documentElement).fontSize);
  wrap.style.fontSize = `${base}px`;

  // своя высота контента: сумма строк и промежутков (scrollHeight врёт при центрировании)
  const measure = () => {
    const kids = [...wrap.children];
    if (!kids.length) return 0;
    const gap = parseFloat(getComputedStyle(wrap).rowGap) || 0;
    return kids.reduce((sum, n) => sum + n.offsetHeight, 0) + gap * (kids.length - 1);
  };

  const avail = wrap.clientHeight;
  const need = measure();
  if (need > avail && avail > 0) {
    // все размеры строк заданы в em, поэтому высота масштабируется линейно
    wrap.style.fontSize = `${Math.max(6, base * (avail / need) - 0.5)}px`;
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
      if (!prevReveal[key]) scoreEl.classList.add('revealed'); // только что открыли
    } else {
      scoreEl.textContent = '?';
      scoreEl.classList.add('unknown');
    }

    row.append(placeEl, avatar(p, 'avatar'), who, scoreEl);
    wrap.appendChild(row);
  }
  return wrap;
}

function soloView(p, { winner = false } = {}) {
  const box = el('div', 'solo');
  const frame = el('div', 'portrait-wrap');
  frame.style.position = 'relative';
  const img = avatar(p, 'portrait');
  frame.appendChild(img);
  if (winner) frame.appendChild(el('div', 'crown', '♛'));

  const info = el('div', 'solo-info');
  info.appendChild(el('div', 'solo-name', p.name || 'Без имени'));
  if (p.note) info.appendChild(el('div', 'solo-note', p.note));

  const items = MM.ordered(state, null);
  const me = items.find((i) => i.p.id === p.id);
  const revealed = me ? me.revealed : false;

  const total = el('div', 'solo-total');
  total.appendChild(el('b', null, revealed ? String(MM.total(state, p.id)) : '?'));
  total.appendChild(el('span', null, revealed && me.place ? `баллов · ${me.place} место` : 'баллов'));
  info.appendChild(total);

  // разбивка по конкурсам — показываем только открытые оценки.
  // Длину полосок меряем от лучшей оценки за один конкурс, иначе они все выглядят короткими.
  const allScores = state.participants.flatMap((q) => state.contests.map((c) => MM.score(state, q.id, c.id) || 0));
  const max = Math.max(1, ...allScores);
  const bd = el('div', 'breakdown');
  for (const c of state.contests) {
    const v = MM.score(state, p.id, c.id);
    const shown = MM.isRevealed(state, c.id, p.id) || revealed;
    const line = el('div', 'bd-row');
    line.appendChild(el('div', 'bd-name', c.name));
    const bar = el('div', 'bd-bar');
    const fill = el('div', 'bd-fill');
    fill.style.width = shown && v !== null ? `${Math.max(2, (v / max) * 100)}%` : '0%';
    bar.appendChild(fill);
    line.appendChild(bar);
    line.appendChild(el('div', 'bd-val', shown && v !== null ? String(v) : '—'));
    bd.appendChild(line);
  }
  if (state.contests.length) info.appendChild(bd);

  box.append(frame, info);
  return box;
}

function render() {
  if (!state) return;
  document.getElementById('title').textContent = state.settings.title || '';
  document.getElementById('subtitle').textContent = state.settings.subtitle || '';

  const d = state.display;

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

  fitRows();
  playRects();

  prevReveal = { ...d.reveal };
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
