// Пульт ведущего: правит состояние и отправляет его на сервер,
// сервер раздаёт изменения экрану зеркала (и другим открытым пультам).

let state = null;
let myRev = -1; // чтобы не перерисовывать пульт от собственного эха

const $ = (sel) => document.querySelector(sel);
const conn = $('#conn');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

async function push() {
  render();
  try {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    const data = await res.json();
    if (data.rev) myRev = data.rev;
  } catch {
    conn.textContent = 'нет связи с сервером';
    conn.className = 'conn bad';
  }
}

// --- вкладки ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => {
      p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
    fitPreview();
  });
});

// --- предпросмотр: вписываем кадр 1920x1080 в доступную ширину ---
function fitPreview() {
  const box = $('.preview');
  const frame = $('#preview');
  if (!box || !frame || !box.clientWidth) return;
  frame.style.transform = `scale(${box.clientWidth / 1920})`;
}
addEventListener('resize', fitPreview);

// --- режимы экрана ---
const MODES = [
  { id: 'standby', label: 'Ожидание' },
  { id: 'leaderboard', label: 'Общий рейтинг' },
  { id: 'contest', label: 'Конкурс' },
  { id: 'spotlight', label: 'Один участник' },
  { id: 'winner', label: 'Победитель' },
];

function renderModes() {
  const host = $('#modes');
  host.innerHTML = '';
  for (const m of MODES) {
    const b = el('button', 'btn', m.label);
    if (state.display.mode === m.id) b.classList.add('is-active', 'btn-gold');
    b.addEventListener('click', () => {
      state.display.mode = m.id;
      if (m.id === 'contest' && !state.display.contestId && state.contests[0]) {
        state.display.contestId = state.contests[0].id;
      }
      if (m.id === 'spotlight' || m.id === 'winner') count().runId = 0;
      if ((m.id === 'spotlight' || m.id === 'winner') && !state.display.spotlightId) {
        // по умолчанию — лидер по сумме
        const best = [...state.participants].sort((a, b2) => MM.total(state, b2.id) - MM.total(state, a.id))[0];
        if (best) state.display.spotlightId = best.id;
      }
      push();
    });
    host.appendChild(b);
  }

  const solo = state.display.mode === 'spotlight' || state.display.mode === 'winner';
  $('#contest-picker').hidden = state.display.mode !== 'contest';
  $('#person-picker').hidden = !solo;
  $('#count-box').hidden = !solo;
  $('#reveal-box').hidden = solo; // в режиме одного участника баллы начисляются счётчиком

  const cs = $('#mode-contest');
  cs.innerHTML = '';
  for (const c of state.contests) {
    const o = el('option', null, c.name);
    o.value = c.id;
    if (c.id === state.display.contestId) o.selected = true;
    cs.appendChild(o);
  }

  const ps = $('#mode-person');
  ps.innerHTML = '';
  for (const p of state.participants) {
    const o = el('option', null, p.name || 'Без имени');
    o.value = p.id;
    if (p.id === state.display.spotlightId) o.selected = true;
    ps.appendChild(o);
  }

  renderCount();
}

// --- начисление баллов на крупном портрете ---
function count() {
  state.display.count = state.display.count || { source: 'total', runId: 0, duration: 3000, showBreakdown: false };
  return state.display.count;
}

function renderCount() {
  const c = count();
  const src = $('#count-source');
  src.innerHTML = '';
  const total = el('option', null, 'Общую сумму баллов');
  total.value = 'total';
  src.appendChild(total);
  for (const x of state.contests) {
    const o = el('option', null, `Баллы за «${x.name}»`);
    o.value = x.id;
    src.appendChild(o);
  }
  src.value = state.contests.some((x) => x.id === c.source) ? c.source : 'total';

  // если в состоянии оказалась длительность не из списка, показываем ближайшую
  const durations = [...$('#count-duration').options].map((o) => Number(o.value));
  const wanted = Number(c.duration) || 3000;
  const nearest = durations.reduce((a, b) => (Math.abs(b - wanted) < Math.abs(a - wanted) ? b : a));
  $('#count-duration').value = String(nearest);
  $('#count-breakdown').checked = !!c.showBreakdown;

  const p = state.participants.find((x) => x.id === state.display.spotlightId);
  const contest = state.contests.find((x) => x.id === c.source);
  const target = p ? (contest ? (MM.score(state, p.id, contest.id) ?? 0) : MM.total(state, p.id)) : null;
  $('#count-hint').textContent = p
    ? (c.runId
      ? `На экране ${p.name}: баллы накручены до ${target}. «Вернуть на 0» — и можно объявлять заново.`
      : `На экране ${p.name}, счётчик на нуле. Нажмите «Начислить баллы» — число доедет до ${target}.`)
    : 'Выберите участника.';
  $('#count-run').textContent = c.runId ? 'Начислить заново' : 'Начислить баллы';
  const hint = el('kbd', null, 'пробел');
  $('#count-run').appendChild(document.createTextNode(' '));
  $('#count-run').appendChild(hint);
}

$('#count-source').addEventListener('change', (e) => {
  count().source = e.target.value;
  count().runId = 0; // другая цифра — начинаем с нуля
  push();
});
$('#count-duration').addEventListener('change', (e) => { count().duration = Number(e.target.value); push(); });
$('#count-breakdown').addEventListener('change', (e) => { count().showBreakdown = e.target.checked; push(); });

function runCount() {
  if (!state.display.spotlightId) return;
  count().runId = (count().runId || 0) + 1; // новый номер запуска — экран крутит счётчик заново
  push();
}
$('#count-run').addEventListener('click', runCount);
$('#count-reset').addEventListener('click', () => { count().runId = 0; push(); });

$('#mode-contest').addEventListener('change', (e) => { state.display.contestId = e.target.value; push(); });
$('#mode-person').addEventListener('change', (e) => {
  state.display.spotlightId = e.target.value;
  count().runId = 0; // следующий участник начинает с нуля
  push();
});
$('#message').addEventListener('input', (e) => { state.display.message = e.target.value; push(); });
$('#show-places').addEventListener('change', (e) => { state.display.showPlaces = e.target.checked; push(); });

// --- открытие баллов ---
// В каком контексте открываем: конкурс (режим «Конкурс») или сумму (все остальные режимы).
function revealContext() {
  if (state.display.mode === 'contest') {
    const c = state.contests.find((x) => x.id === state.display.contestId);
    return { contestId: c ? c.id : null, label: c ? `конкурс «${c.name}»` : 'конкурс не выбран' };
  }
  return { contestId: null, label: 'общая сумма баллов' };
}

function renderReveal() {
  const { contestId, label } = revealContext();
  $('#reveal-context').textContent = `Открываем: ${label}. Нераскрытые участники стоят на экране внизу со знаком «?».`;

  const host = $('#reveal-list');
  host.innerHTML = '';
  // в пульте сортируем по баллам (ведущий видит правду), снизу вверх — как в эфире
  const live = state.participants.filter((p) => !p.hidden);
  const rows = live
    .map((p) => ({
      p,
      value: contestId ? MM.score(state, p.id, contestId) : MM.total(state, p.id),
      open: MM.isRevealed(state, contestId, p.id),
    }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  rows.forEach((r, i) => {
    const item = el('div', 'reveal-item');
    if (r.open) item.classList.add('is-open');
    item.appendChild(el('div', 'idx', String(i + 1)));

    if (r.p.photo) {
      const img = el('img', 'pic');
      img.src = r.p.photo;
      item.appendChild(img);
    } else {
      item.appendChild(el('div', 'pic', (r.p.name || '?').charAt(0).toUpperCase()));
    }

    item.appendChild(el('div', 'nm', r.p.name || 'Без имени'));
    item.appendChild(el('div', 'val', r.value === null ? '—' : String(r.value)));

    const b = el('button', 'btn small', r.open ? 'Скрыть' : 'Открыть');
    b.addEventListener('click', () => {
      const key = MM.revealKey(contestId, r.p.id);
      if (r.open) delete state.display.reveal[key];
      else state.display.reveal[key] = true;
      push();
    });
    item.appendChild(b);
    host.appendChild(item);
  });
}

// Открыть следующего — классика эфира: с последнего места вверх.
function revealNext() {
  const { contestId } = revealContext();
  const pending = state.participants
    .filter((p) => !p.hidden && !MM.isRevealed(state, contestId, p.id))
    .map((p) => ({ p, value: contestId ? MM.score(state, p.id, contestId) : MM.total(state, p.id) }))
    .sort((a, b) => (a.value ?? -1) - (b.value ?? -1));
  if (!pending.length) return;
  state.display.reveal[MM.revealKey(contestId, pending[0].p.id)] = true;
  push();
}

$('#reveal-next').addEventListener('click', revealNext);
$('#reveal-all').addEventListener('click', () => {
  const { contestId } = revealContext();
  for (const p of state.participants) state.display.reveal[MM.revealKey(contestId, p.id)] = true;
  push();
});
$('#reveal-none').addEventListener('click', () => {
  const { contestId } = revealContext();
  for (const p of state.participants) delete state.display.reveal[MM.revealKey(contestId, p.id)];
  push();
});

// пробел = открыть следующего, если курсор не в поле ввода
addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  if (e.code === 'Space' && !typing) {
    e.preventDefault();
    const solo = state.display.mode === 'spotlight' || state.display.mode === 'winner';
    if (solo) runCount();
    else revealNext();
  }
});

// --- участники ---
async function uploadPhoto(file) {
  const dataUrl = await shrink(file, 700);
  const res = await fetch('/api/photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Не удалось загрузить фото');
  return data.url;
}

// Уменьшаем фото в браузере: на экране портрет небольшой, зато файл лёгкий.
function shrink(file, max) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не читается файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Это не картинка'));
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * k);
        const h = Math.round(img.height * k);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

$('#add-person').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = form.name.value.trim();
  if (!name) return;
  const p = { id: uid('u'), name, note: form.note.value.trim(), photo: '', out: false, hidden: false };
  const file = form.photo.files[0];
  form.reset();
  if (file) {
    try { p.photo = await uploadPhoto(file); } catch (err) { alert(err.message); }
  }
  state.participants.push(p);
  state.scores[p.id] = state.scores[p.id] || {};
  push();
});

function renderPeople() {
  const host = $('#people');
  host.innerHTML = '';
  if (!state.participants.length) {
    host.appendChild(el('p', 'hint', 'Пока никого нет. Добавьте участников сверху.'));
    return;
  }
  for (const p of state.participants) {
    const card = el('div', 'person');
    if (p.out) card.classList.add('is-out');

    const pic = p.photo ? el('img', 'pic') : el('div', 'pic', 'фото');
    if (p.photo) pic.src = p.photo;
    pic.title = 'Нажмите, чтобы выбрать фото';
    pic.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.onchange = async () => {
        if (!inp.files[0]) return;
        try {
          p.photo = await uploadPhoto(inp.files[0]);
          push();
        } catch (err) { alert(err.message); }
      };
      inp.click();
    });
    // перетаскивание файла прямо на карточку
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      try { p.photo = await uploadPhoto(file); push(); } catch (err) { alert(err.message); }
    });

    const meta = el('div', 'meta');
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.value = p.name;
    nameInput.addEventListener('change', () => { p.name = nameInput.value.trim(); push(); });
    const noteInput = el('input');
    noteInput.type = 'text';
    noteInput.value = p.note || '';
    noteInput.placeholder = 'Город / регалии';
    noteInput.addEventListener('change', () => { p.note = noteInput.value.trim(); push(); });

    const acts = el('div', 'acts');
    const show = el('button', 'btn small', 'На экран');
    show.addEventListener('click', () => {
      state.display.mode = 'spotlight';
      state.display.spotlightId = p.id;
      count().runId = 0;
      push();
    });
    const out = el('button', 'btn small', p.out ? 'Вернуть в игру' : 'Выбыл');
    out.addEventListener('click', () => { p.out = !p.out; push(); });
    const del = el('button', 'btn small btn-danger', 'Удалить');
    del.addEventListener('click', () => {
      if (!confirm(`Удалить участника «${p.name}»?`)) return;
      state.participants = state.participants.filter((x) => x.id !== p.id);
      delete state.scores[p.id];
      for (const key of Object.keys(state.display.reveal)) {
        if (key.endsWith(`:${p.id}`)) delete state.display.reveal[key];
      }
      if (state.display.spotlightId === p.id) state.display.spotlightId = null;
      push();
    });
    acts.append(show, out, del);

    meta.append(nameInput, noteInput, acts);
    card.append(pic, meta);
    host.appendChild(card);
  }
}

// --- конкурсы ---
$('#add-contest').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  e.target.reset();
  state.contests.push({ id: uid('c'), name });
  push();
});

function renderContests() {
  const host = $('#contests');
  host.innerHTML = '';
  state.contests.forEach((c, i) => {
    const row = el('div', 'contest');
    row.appendChild(el('div', 'num', String(i + 1)));
    const input = el('input');
    input.type = 'text';
    input.value = c.name;
    input.addEventListener('change', () => { c.name = input.value.trim(); push(); });
    row.appendChild(input);

    const show = el('button', 'btn small', 'На экран');
    show.addEventListener('click', () => {
      state.display.mode = 'contest';
      state.display.contestId = c.id;
      push();
    });
    const up = el('button', 'btn small', '↑');
    up.addEventListener('click', () => {
      if (i === 0) return;
      [state.contests[i - 1], state.contests[i]] = [state.contests[i], state.contests[i - 1]];
      push();
    });
    const del = el('button', 'btn small btn-danger', 'Удалить');
    del.addEventListener('click', () => {
      if (!confirm(`Удалить конкурс «${c.name}» вместе с баллами?`)) return;
      state.contests = state.contests.filter((x) => x.id !== c.id);
      for (const pid of Object.keys(state.scores)) delete state.scores[pid][c.id];
      for (const key of Object.keys(state.display.reveal)) {
        if (key.startsWith(`${c.id}:`)) delete state.display.reveal[key];
      }
      if (state.display.contestId === c.id) state.display.contestId = null;
      push();
    });
    row.append(show, up, del);
    host.appendChild(row);
  });
}

// --- таблица баллов ---
function renderScores() {
  const table = $('#score-table');
  table.innerHTML = '';
  const head = table.insertRow();
  head.appendChild(el('th', null, 'Участник'));
  for (const c of state.contests) head.appendChild(el('th', null, c.name));
  head.appendChild(el('th', null, 'Сумма'));

  for (const p of state.participants) {
    const tr = table.insertRow();
    const who = el('td', 'who', p.name || 'Без имени');
    tr.appendChild(who);
    for (const c of state.contests) {
      const td = el('td');
      const input = el('input');
      input.type = 'number';
      input.step = 'any';
      input.value = MM.score(state, p.id, c.id) ?? '';
      input.addEventListener('input', () => {
        state.scores[p.id] = state.scores[p.id] || {};
        const raw = input.value.trim();
        state.scores[p.id][c.id] = raw === '' ? null : Number(raw);
        // перерисовку таблицы не дёргаем, чтобы не терять фокус
        pushQuiet();
      });
      td.appendChild(input);
      tr.appendChild(td);
    }
    tr.appendChild(el('td', 'total', String(MM.total(state, p.id))));
  }

  if (!state.participants.length) {
    const tr = table.insertRow();
    const td = el('td', null, 'Сначала добавьте участников');
    td.colSpan = state.contests.length + 2;
    tr.appendChild(td);
  }
}

// отправка без полной перерисовки (для полей ввода баллов)
let quietTimer = null;
function pushQuiet() {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      const data = await res.json();
      if (data.rev) myRev = data.rev;
      renderTotalsOnly();
      renderReveal();
    } catch { /* сеть отвалилась — состояние останется локальным до следующей правки */ }
  }, 250);
}

function renderTotalsOnly() {
  const rows = $('#score-table').rows;
  for (let i = 1; i <= state.participants.length && i < rows.length; i += 1) {
    const cell = rows[i].cells[rows[i].cells.length - 1];
    if (cell) cell.textContent = String(MM.total(state, state.participants[i - 1].id));
  }
}

// --- звук ---
function soundCfg() {
  state.display.sound = state.display.sound || { on: true, volume: 0.7, ambient: false, testId: 0 };
  return state.display.sound;
}

function renderSound() {
  const snd = soundCfg();
  $('#sound-on').checked = snd.on !== false;
  $('#sound-volume').value = String(Math.round((snd.volume ?? 0.7) * 100));
  $('#sound-volume-value').textContent = `${Math.round((snd.volume ?? 0.7) * 100)}%`;
  $('#sound-ambient').checked = !!snd.ambient;
  const btn = $('#mute-toggle');
  btn.textContent = snd.on !== false ? 'Звук вкл.' : 'Звук выкл.';
  btn.classList.toggle('is-off', snd.on === false);
}

$('#sound-on').addEventListener('change', (e) => { soundCfg().on = e.target.checked; push(); });
$('#mute-toggle').addEventListener('click', () => { soundCfg().on = soundCfg().on === false; push(); });
$('#sound-ambient').addEventListener('change', (e) => { soundCfg().ambient = e.target.checked; push(); });
$('#sound-volume').addEventListener('input', (e) => {
  soundCfg().volume = Number(e.target.value) / 100;
  $('#sound-volume-value').textContent = `${e.target.value}%`;
  pushQuiet(); // ползунок двигают часто — не перерисовываем пульт на каждый шаг
});
$('#sound-test').addEventListener('click', () => {
  soundCfg().testId = (soundCfg().testId || 0) + 1;
  push();
});

// --- настройки ---
$('#set-title').addEventListener('change', (e) => { state.settings.title = e.target.value; push(); });
$('#set-subtitle').addEventListener('change', (e) => { state.settings.subtitle = e.target.value; push(); });

$('#clear-scores').addEventListener('click', () => {
  if (!confirm('Обнулить все баллы и скрыть все открытые оценки?')) return;
  state.scores = {};
  state.display.reveal = {};
  push();
});

$('#reset-all').addEventListener('click', async () => {
  if (!confirm('Стереть участников, конкурсы и баллы? Отменить будет нельзя.')) return;
  await fetch('/api/reset', { method: 'POST' });
});

$('#open-display').addEventListener('click', () => {
  window.open('display.html', 'mirror', 'popup');
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `зеркало-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.participants)) throw new Error('В файле нет участников');
    state = parsed;
    push();
  } catch (err) {
    alert(`Файл не подходит: ${err.message}`);
  }
  e.target.value = '';
});

// --- общая перерисовка ---
function render() {
  if (!state) return;
  renderModes();
  renderReveal();
  renderPeople();
  renderContests();
  renderScores();
  $('#message').value = state.display.message || '';
  $('#show-places').checked = !!state.display.showPlaces;
  $('#set-title').value = state.settings.title || '';
  $('#set-subtitle').value = state.settings.subtitle || '';
  renderSound();
  fitPreview();
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (ev) => {
    conn.textContent = 'связь есть';
    conn.className = 'conn ok';
    const incoming = JSON.parse(ev.data);
    if (incoming.rev === myRev) return; // наше же изменение вернулось — не трогаем поля
    state = incoming;
    render();
  });
  es.onerror = () => {
    conn.textContent = 'нет связи';
    conn.className = 'conn bad';
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 1500);
  };
}
connect();
