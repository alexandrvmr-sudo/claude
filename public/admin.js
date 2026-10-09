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
    if (tab.dataset.tab === 'shows') renderShows();
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
  { id: 'groups', label: 'Сетка тура', tournamentOnly: true },
  { id: 'leaderboard', label: 'Общий рейтинг' },
  { id: 'contest', label: 'Конкурс' },
  { id: 'spotlight', label: 'Один участник' },
  { id: 'winner', label: 'Победитель' },
];

function renderModes() {
  const host = $('#modes');
  host.innerHTML = '';
  for (const m of MODES.filter((m) => !m.tournamentOnly || MM.isTournament(state))) {
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
  const round = MM.isTournament(state) ? currentRound() : null;
  for (const c of (round ? MM.roundContests(state, round.id) : state.contests)) {
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
  const live = () => state.participants.filter((p) => !p.hidden);
  if (state.display.mode === 'groups') {
    const r = currentRound();
    return {
      contestId: r ? r.id : null,
      label: r ? `баллы за тур «${r.name}»` : 'тур не сформирован',
      people: r ? MM.roundMembers(state, r) : [],
      value: (pid) => (r ? MM.roundScore(state, pid, r.id) : null),
    };
  }
  if (state.display.mode === 'contest') {
    const c = state.contests.find((x) => x.id === state.display.contestId);
    return {
      contestId: c ? c.id : null,
      label: c ? `конкурс «${c.name}»` : 'конкурс не выбран',
      people: MM.ordered(state, c ? c.id : null).map((i) => i.p),
      value: (pid) => (c ? MM.score(state, pid, c.id) : null),
    };
  }
  return {
    contestId: null,
    label: 'общая сумма баллов',
    people: live(),
    value: (pid) => MM.total(state, pid),
  };
}

function renderReveal() {
  const ctx = revealContext();
  const { contestId, label } = ctx;
  $('#reveal-context').textContent = `Открываем: ${label}. Нераскрытые участники стоят на экране внизу со знаком «?».`;

  const host = $('#reveal-list');
  host.innerHTML = '';
  // в пульте сортируем по баллам (ведущий видит правду), снизу вверх — как в эфире
  const rows = ctx.people
    .map((p) => ({
      p,
      value: ctx.value(p.id),
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
  const ctx = revealContext();
  const { contestId } = ctx;
  const pending = ctx.people
    .filter((p) => !MM.isRevealed(state, contestId, p.id))
    .map((p) => ({ p, value: ctx.value(p.id) }))
    .sort((a, b) => (a.value ?? -1) - (b.value ?? -1));
  if (!pending.length) return;
  state.display.reveal[MM.revealKey(contestId, pending[0].p.id)] = true;
  push();
}

$('#reveal-next').addEventListener('click', revealNext);
$('#reveal-all').addEventListener('click', () => {
  const ctx = revealContext();
  for (const p of ctx.people) state.display.reveal[MM.revealKey(ctx.contestId, p.id)] = true;
  push();
});
$('#reveal-none').addEventListener('click', () => {
  const ctx = revealContext();
  for (const p of ctx.people) delete state.display.reveal[MM.revealKey(ctx.contestId, p.id)];
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

    if (c.roundId) {
      const round = MM.tour(state).rounds.find((r) => r.id === c.roundId);
      row.appendChild(el('div', 'meta', round ? round.name : 'тур'));
    }
    row.appendChild(musicSelect(c));

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

  // В турнире показываем только текущий тур: его конкурсы и его участников.
  const round = MM.isTournament(state) ? currentRound() : null;
  const contests = round ? MM.roundContests(state, round.id) : state.contests.filter((c) => !c.roundId);
  const people = round ? MM.roundMembers(state, round) : state.participants;
  const note = $('#scores-note');
  if (note) {
    note.textContent = round
      ? `Идёт «${round.name}»: в таблице только его конкурсы и участники.`
      : '';
    note.hidden = !round;
  }

  const head = table.insertRow();
  head.appendChild(el('th', null, 'Участник'));
  for (const c of contests) head.appendChild(el('th', null, c.name));
  head.appendChild(el('th', null, round ? 'За тур' : 'Сумма'));

  for (const p of people) {
    const tr = table.insertRow();
    const who = el('td', 'who', p.name || 'Без имени');
    tr.appendChild(who);
    for (const c of contests) {
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
    tr.appendChild(el('td', 'total',
      String(round ? MM.roundScore(state, p.id, round.id) : MM.total(state, p.id))));
  }

  if (!people.length) {
    const tr = table.insertRow();
    const td = el('td', null, 'Сначала добавьте участников');
    td.colSpan = contests.length + 2;
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
  const round = MM.isTournament(state) ? currentRound() : null;
  const people = round ? MM.roundMembers(state, round) : state.participants;
  const rows = $('#score-table').rows;
  for (let i = 1; i <= people.length && i < rows.length; i += 1) {
    const cell = rows[i].cells[rows[i].cells.length - 1];
    if (!cell) continue;
    cell.textContent = String(round
      ? MM.roundScore(state, people[i - 1].id, round.id)
      : MM.total(state, people[i - 1].id));
  }
}

// --- музыка заданий ---
// Файлы лежат в папке public/music/tasks, программа читает её сама.
let taskTracks = [];

async function loadTaskTracks() {
  try {
    const data = await (await fetch('/api/music')).json();
    taskTracks = data.tasks || [];
  } catch {
    taskTracks = [];
  }
}

// Какой трек достанется конкурсу: тот же расчёт, что и на экране.
function trackForContest(contestId) {
  if (!taskTracks.length) return null;
  const i = state.contests.findIndex((x) => x.id === contestId);
  if (i < 0) return null;
  const chosen = state.contests[i].music;
  if (chosen === 'none') return null;
  if (chosen && taskTracks.includes(chosen)) return chosen;
  return taskTracks[i % taskTracks.length];
}

// Выпадающий список выбора трека для конкурса
function musicSelect(contest) {
  const sel = el('select');
  sel.title = 'Музыка задания';
  const auto = el('option', null, taskTracks.length
    ? `Авто: ${trackForContest(contest.id) || 'нет файлов'}`
    : 'Авто (нет файлов)');
  auto.value = '';
  sel.appendChild(auto);
  for (const f of taskTracks) {
    const o = el('option', null, f);
    o.value = f;
    sel.appendChild(o);
  }
  const none = el('option', null, 'Без музыки');
  none.value = 'none';
  sel.appendChild(none);
  sel.value = contest.music || '';
  sel.addEventListener('change', () => {
    if (sel.value) contest.music = sel.value;
    else delete contest.music;
    push();
  });
  return sel;
}

// --- турнир ---
// Участники сражаются группами, из каждой группы дальше проходят лучшие.
function tour() {
  state.tournament = state.tournament
    || { on: false, groupSize: 3, advance: 2, rounds: [], currentRoundId: null };
  return state.tournament;
}

function currentRound() {
  const t = tour();
  return t.rounds.find((r) => r.id === t.currentRoundId) || null;
}

const groupLabel = (size, i) => (size === 3 ? `Тройка ${i + 1}` : `Группа ${i + 1}`);

// Сколько групп делать. В группе должно остаться больше людей, чем проходит
// дальше, иначе тур ничего не решает: из двойки по двое проходят оба и турнир
// крутится на месте. Когда так не получается — это уже финал, одна группа.
function groupCountFor(n, size, advance) {
  let count = Math.max(1, Math.ceil(n / size));
  while (count > 1 && Math.floor(n / count) <= advance) count -= 1;
  return count;
}

// Раскладываем как можно ровнее: восьмерых по трое — это 3 + 3 + 2.
function splitIntoGroups(ids, size, advance) {
  const count = groupCountFor(ids.length, size, advance);
  const groups = Array.from({ length: count }, (_, i) => ({
    id: uid('g'), name: count === 1 ? 'Финал' : groupLabel(size, i), members: [],
  }));
  ids.forEach((pid, i) => groups[i % count].members.push(pid));
  return groups;
}

function roundName(index, groupCount) {
  if (groupCount === 1) return 'Финал';
  if (index === 0) return 'Отборочный тур';
  return `Тур ${index + 1}`;
}

function makeRound(memberIds, index) {
  const t = tour();
  const groups = splitIntoGroups(memberIds, t.groupSize, t.advance);
  const round = {
    id: uid('r'),
    name: roundName(index, groups.length),
    groups,
    advancing: [],
    finished: false,
  };
  // у каждого тура свои конкурсы — заводим первый сразу
  state.contests.push({ id: uid('c'), name: 'Испытание 1', roundId: round.id });
  return round;
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

$('#tour-on').addEventListener('change', (e) => { tour().on = e.target.checked; push(); });
$('#tour-size').addEventListener('change', (e) => {
  tour().groupSize = Math.max(2, Math.min(8, Number(e.target.value) || 3));
  push();
});
$('#tour-advance').addEventListener('change', (e) => {
  tour().advance = Math.max(1, Math.min(7, Number(e.target.value) || 2));
  push();
});

$('#tour-start').addEventListener('click', () => {
  const t = tour();
  const ids = state.participants.filter((p) => !p.hidden).map((p) => p.id);
  if (ids.length < 2) return alert('Сначала внесите участников на вкладке «Участники».');
  if (t.rounds.length && !confirm('Начать турнир заново? Текущие туры будут удалены.')) return;
  for (const c of state.contests) if (c.roundId) delete c.roundId; // старые туры отвязываем
  t.rounds = [makeRound(shuffle(ids), 0)];
  t.currentRoundId = t.rounds[0].id;
  t.on = true;
  return push();
});

$('#tour-reshuffle').addEventListener('click', () => {
  const round = currentRound();
  if (!round) return alert('Сначала сформируйте тур.');
  if (round.finished) return alert('Тур уже подведён — сначала вернитесь к вводу баллов.');
  const ids = shuffle(round.groups.flatMap((g) => g.members));
  const groups = splitIntoGroups(ids, tour().groupSize, tour().advance);
  round.groups = groups.map((g, i) => ({ ...g, name: round.groups[i] ? round.groups[i].name : g.name }));
  return push();
});

$('#tour-reset').addEventListener('click', () => {
  if (!confirm('Сбросить турнир? Группы и туры удалятся, конкурсы и баллы останутся.')) return;
  const t = tour();
  for (const c of state.contests) if (c.roundId) delete c.roundId;
  t.rounds = [];
  t.currentRoundId = null;
  t.on = false;
  if (state.display.mode === 'groups') state.display.mode = 'standby';
  push();
});

function finishRound() {
  const round = currentRound();
  if (!round) return;
  // проходящих считаем до того, как пометим тур подведённым
  round.advancing = round.groups.flatMap(
    (g) => MM.groupStanding(state, round, g).filter((r) => r.advances).map((r) => r.p.id),
  );
  round.finished = true;
  push();
}

function nextRound() {
  const t = tour();
  const round = currentRound();
  if (!round || !round.finished) return;
  const members = round.advancing.slice();
  if (members.length < 2) {
    return alert('Дальше проходит меньше двух человек — это уже победитель турнира.');
  }
  const next = makeRound(members, t.rounds.length);
  t.rounds.push(next);
  t.currentRoundId = next.id;
  return push();
}

function renderTournament() {
  const t = tour();
  $('#tour-on').checked = !!t.on;
  $('#tour-size').value = String(t.groupSize || 3);
  $('#tour-advance').value = String(t.advance || 2);
  $('#tour-setup').hidden = !t.on;

  const current = $('#tour-current');
  const history = $('#tour-history');
  current.innerHTML = '';
  history.innerHTML = '';
  if (!t.on) return;

  const live = state.participants.filter((p) => !p.hidden).length;
  const groupsCount = groupCountFor(live, t.groupSize || 3, t.advance || 2);
  $('#tour-hint').textContent = t.rounds.length
    ? `Каждый тур живёт своими конкурсами — баллы прошлых туров на следующий не переносятся.`
    : `${live} участников — получится ${groupsCount} групп, дальше пройдут ${groupsCount * (t.advance || 2)} человек.`;

  const round = currentRound();
  if (!round) return;

  // --- шапка тура ---
  const head = el('div', 'round-head');
  const name = el('input');
  name.type = 'text';
  name.value = round.name;
  name.addEventListener('change', () => { round.name = name.value.trim() || round.name; push(); });
  const badge = el('div', `round-badge${round.finished ? ' done' : ''}`,
    round.finished ? 'итоги подведены' : `тур ${t.rounds.indexOf(round) + 1} из ${t.rounds.length}`);
  head.append(badge, name);
  current.appendChild(head);

  // --- конкурсы тура ---
  const chips = el('div', 'round-contests');
  chips.appendChild(el('span', 'hint', 'Конкурсы тура:'));
  for (const c of MM.roundContests(state, round.id)) {
    const chip = el('div', 'chip');
    const input = el('input');
    input.type = 'text';
    input.value = c.name;
    input.addEventListener('change', () => { c.name = input.value.trim() || c.name; push(); });
    const del = el('button', 'btn small btn-danger', '×');
    del.title = 'Удалить конкурс вместе с баллами';
    del.addEventListener('click', () => {
      if (!confirm(`Удалить конкурс «${c.name}» вместе с баллами?`)) return;
      state.contests = state.contests.filter((x) => x.id !== c.id);
      for (const pid of Object.keys(state.scores)) delete state.scores[pid][c.id];
      push();
    });
    chip.append(input, del);
    chips.appendChild(chip);
  }
  const addContest = el('button', 'btn small', '+ конкурс');
  addContest.addEventListener('click', () => {
    const n = MM.roundContests(state, round.id).length + 1;
    state.contests.push({ id: uid('c'), name: `Испытание ${n}`, roundId: round.id });
    push();
  });
  chips.appendChild(addContest);
  current.appendChild(chips);

  // --- группы ---
  const groupsBox = el('div', 'groups');
  for (const group of round.groups) {
    const card = el('div', 'group-card');
    const gname = el('input');
    gname.type = 'text';
    gname.value = group.name;
    gname.addEventListener('change', () => { group.name = gname.value.trim() || group.name; push(); });
    card.appendChild(gname);

    for (const row of MM.groupStanding(state, round, group)) {
      const line = el('div', `group-row${row.advances ? ' goes' : ''}`);
      line.appendChild(el('div', 'place', String(row.place)));

      if (row.p.photo) {
        const img = el('img', 'pic');
        img.src = row.p.photo;
        line.appendChild(img);
      } else {
        line.appendChild(el('div', 'pic'));
      }

      const nm = el('div', 'nm', row.p.name || 'Без имени');
      if (row.tie) {
        nm.appendChild(el('div', 'tie', 'ничья на границе — решите, кто проходит'));
      }
      line.appendChild(nm);
      line.appendChild(el('div', 'val', String(row.value)));

      if (round.finished) {
        const label = el('label', 'check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = row.advances;
        box.title = 'Проходит дальше';
        box.addEventListener('change', () => {
          const list = new Set(round.advancing);
          if (box.checked) list.add(row.p.id);
          else list.delete(row.p.id);
          round.advancing = [...list];
          push();
        });
        label.append(box, document.createTextNode(' дальше'));
        line.appendChild(label);
      } else {
        const move = el('select');
        move.title = 'Перевести в другую группу';
        for (const g of round.groups) {
          const o = el('option', null, g.name);
          o.value = g.id;
          if (g.id === group.id) o.selected = true;
          move.appendChild(o);
        }
        move.addEventListener('change', () => {
          const target = round.groups.find((g) => g.id === move.value);
          if (!target || target.id === group.id) return;
          group.members = group.members.filter((x) => x !== row.p.id);
          target.members.push(row.p.id);
          push();
        });
        line.appendChild(move);
      }
      card.appendChild(line);
    }
    groupsBox.appendChild(card);
  }
  current.appendChild(groupsBox);

  // --- итоги ---
  const done = el('div', 'round-done');
  if (!round.finished) {
    done.appendChild(el('p', 'hint',
      `Внесите баллы на вкладке «Баллы» и подведите итоги — дальше пройдут по ${t.advance} из каждой группы.`));
    const b = el('button', 'btn btn-gold big', 'Подвести итоги тура');
    b.addEventListener('click', finishRound);
    done.appendChild(b);
  } else {
    const names = round.advancing
      .map((pid) => (state.participants.find((p) => p.id === pid) || {}).name)
      .filter(Boolean);
    done.appendChild(el('p', 'hint', names.length
      ? `Дальше проходят (${names.length}): ${names.join(', ')}`
      : 'Пока никто не отмечен — поставьте галочки «дальше».'));
    const acts = el('div', 'reveal-actions');
    const b = el('button', 'btn btn-gold big', names.length > 1 ? 'Сформировать следующий тур' : 'Это победитель');
    b.addEventListener('click', () => {
      if (names.length > 1) nextRound();
      else alert('Отметьте галочками тех, кто идёт дальше.');
    });
    const back = el('button', 'btn', 'Вернуться к вводу баллов');
    back.addEventListener('click', () => { round.finished = false; push(); });
    acts.append(b, back);
    done.appendChild(acts);
  }
  current.appendChild(done);

  // --- прошедшие туры ---
  const past = t.rounds.filter((r) => r.id !== round.id);
  if (past.length) {
    history.appendChild(el('h2', 'mt', 'Пройденные туры'));
    for (const r of past) {
      const line = el('div', 'history-round');
      const who = (r.advancing || [])
        .map((pid) => (state.participants.find((p) => p.id === pid) || {}).name)
        .filter(Boolean);
      line.appendChild(el('b', null, r.name));
      line.appendChild(document.createTextNode(
        ` — ${r.groups.length} групп, дальше прошли: ${who.join(', ') || '—'}`));
      const open = el('button', 'btn small', 'Вернуться к нему');
      open.style.marginLeft = '0.6rem';
      open.addEventListener('click', () => {
        if (!confirm(`Сделать «${r.name}» текущим туром?`)) return;
        tour().currentRoundId = r.id;
        push();
      });
      line.appendChild(open);
      history.appendChild(line);
    }
  }
}

// --- библиотека шоу ---
// Каждое шоу — это участники, конкурсы и баллы, подготовленные заранее.
// Эфир (что сейчас на телевизоре) в шоу не хранится, он всегда начинается с нуля.
async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({ ok: false, error: 'Сервер не ответил' }));
  if (!data.ok) throw new Error(data.error || 'Не получилось');
  return data;
}

async function renderShows() {
  const host = $('#shows');
  let data;
  try {
    data = await api('/api/shows');
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('p', 'hint', `Не удалось прочитать библиотеку: ${e.message}`));
    return;
  }

  host.innerHTML = '';
  if (!data.shows.length) {
    host.appendChild(el('p', 'hint', 'Сохранённых шоу пока нет. Создайте первое — и всё, что внесёте, будет складываться в него.'));
    return;
  }

  for (const show of data.shows) {
    const row = el('div', 'show-row');
    if (show.id === data.current) row.classList.add('is-current');

    const left = el('div');
    left.appendChild(el('div', 'nm', show.name));
    const when = show.updatedAt ? new Date(show.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '';
    left.appendChild(el('div', 'meta',
      `${show.participants} участников · ${show.contests} конкурсов${when ? ' · изменено ' + when : ''}`));
    row.appendChild(left);

    row.appendChild(el('div', 'meta', show.id === data.current ? 'открыто' : ''));

    const acts = el('div', 'acts');
    if (show.id !== data.current) {
      const open = el('button', 'btn small btn-gold', 'Открыть');
      open.addEventListener('click', async () => {
        if (!confirm(`Открыть «${show.name}»? Текущий эфир будет сброшен в режим ожидания.`)) return;
        try {
          await api(`/api/shows/${show.id}/open`, { method: 'POST' });
          renderShows();
        } catch (e) { alert(e.message); }
      });
      acts.appendChild(open);
    }
    const copy = el('button', 'btn small', 'Дублировать');
    copy.addEventListener('click', async () => {
      try { await api(`/api/shows/${show.id}/copy`, { method: 'POST' }); renderShows(); }
      catch (e) { alert(e.message); }
    });
    const rename = el('button', 'btn small', 'Переименовать');
    rename.addEventListener('click', async () => {
      const name = prompt('Новое название шоу:', show.name);
      if (!name) return;
      try { await api(`/api/shows/${show.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); renderShows(); }
      catch (e) { alert(e.message); }
    });
    const del = el('button', 'btn small btn-danger', 'Удалить');
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить шоу «${show.name}»? Его участники и баллы пропадут.`)) return;
      try { await api(`/api/shows/${show.id}`, { method: 'DELETE' }); renderShows(); }
      catch (e) { alert(e.message); }
    });
    acts.append(copy, rename, del);
    row.appendChild(acts);
    host.appendChild(row);
  }
}

$('#add-show').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  if (state.showId && !confirm(`Создать новое пустое шоу «${name}»? Текущее останется в библиотеке.`)) return;
  e.target.reset();
  try { await api('/api/shows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); renderShows(); }
  catch (err) { alert(err.message); }
});

$('#show-save-as').addEventListener('click', async () => {
  const name = prompt('Название нового шоу:', state.showName ? `${state.showName} — копия` : 'Моё шоу');
  if (!name) return;
  try { await api('/api/shows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, from: 'current' }) }); renderShows(); }
  catch (e) { alert(e.message); }
});

$('#show-rename').addEventListener('click', async () => {
  if (!state.showId) return alert('Сейчас не открыто ни одно шоу — создайте его ниже.');
  const name = prompt('Новое название шоу:', state.showName);
  if (!name) return;
  try { await api(`/api/shows/${state.showId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); renderShows(); }
  catch (e) { alert(e.message); }
});

// --- звук ---
function soundCfg() {
  state.display.sound = state.display.sound || { on: true, volume: 0.7, testId: 0 };
  state.display.sound.music = state.display.sound.music || { on: true, volume: 0.6 };
  state.display.sound.taskMusic = state.display.sound.taskMusic || { on: true, volume: 0.5, scan: 0 };
  return state.display.sound;
}

function renderSound() {
  const snd = soundCfg();
  $('#sound-on').checked = snd.on !== false;
  $('#sound-volume').value = String(Math.round((snd.volume ?? 0.7) * 100));
  $('#sound-volume-value').textContent = `${Math.round((snd.volume ?? 0.7) * 100)}%`;
  const music = snd.music || { on: true, volume: 0.6 };
  $('#music-on').checked = music.on !== false;
  $('#music-volume').value = String(Math.round((music.volume ?? 0.6) * 100));
  $('#music-volume-value').textContent = `${Math.round((music.volume ?? 0.6) * 100)}%`;

  const task = snd.taskMusic || { on: true, volume: 0.5 };
  $('#task-music-on').checked = task.on !== false;
  $('#task-music-volume').value = String(Math.round((task.volume ?? 0.5) * 100));
  $('#task-music-volume-value').textContent = `${Math.round((task.volume ?? 0.5) * 100)}%`;
  $('#task-music-found').textContent = taskTracks.length
    ? `Найдено файлов: ${taskTracks.length} — ${taskTracks.join(', ')}`
    : 'Файлов пока нет: скопируйте их в папку public/music/tasks и нажмите «Перечитать папку».';
  const btn = $('#mute-toggle');
  btn.textContent = snd.on !== false ? 'Звук вкл.' : 'Звук выкл.';
  btn.classList.toggle('is-off', snd.on === false);
}

$('#sound-on').addEventListener('change', (e) => { soundCfg().on = e.target.checked; push(); });
$('#mute-toggle').addEventListener('click', () => { soundCfg().on = soundCfg().on === false; push(); });
$('#music-on').addEventListener('change', (e) => { soundCfg().music.on = e.target.checked; push(); });
$('#task-music-on').addEventListener('change', (e) => { soundCfg().taskMusic.on = e.target.checked; push(); });
$('#task-music-volume').addEventListener('input', (e) => {
  soundCfg().taskMusic.volume = Number(e.target.value) / 100;
  $('#task-music-volume-value').textContent = `${e.target.value}%`;
  pushQuiet();
});
$('#task-music-scan').addEventListener('click', async () => {
  await loadTaskTracks();
  soundCfg().taskMusic.scan = (soundCfg().taskMusic.scan || 0) + 1; // экран тоже перечитает
  push();
});
$('#music-volume').addEventListener('input', (e) => {
  soundCfg().music.volume = Number(e.target.value) / 100;
  $('#music-volume-value').textContent = `${e.target.value}%`;
  pushQuiet(); // ползунок двигают часто
});
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

// В приложении окно зеркала открывает сам Electron — и сразу на телевизоре.
// В браузере остаётся обычное всплывающее окно, которое перетаскивают руками.
const inApp = !!(window.mirrorApp && window.mirrorApp.isApp);
if (inApp) $('#open-display').textContent = 'Показать на телевизоре';
$('#open-display').addEventListener('click', () => {
  if (inApp) window.mirrorApp.openMirror();
  else window.open('display.html', 'mirror', 'popup');
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
  renderTournament();
  const title = state.showName || 'шоу не выбрано';
  $('#brand-show').textContent = title;
  $('#current-show').textContent = title;
  fitPreview();
}

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (ev) => {
    conn.textContent = 'связь есть';
    conn.className = 'conn ok';
    const incoming = JSON.parse(ev.data);
    if (incoming.rev === myRev) return; // наше же изменение вернулось — не трогаем поля
    const firstTime = !state;
    state = incoming;
    render();
    if (firstTime) {
      renderShows();
      loadTaskTracks().then(render);
    }
  });
  es.onerror = () => {
    conn.textContent = 'нет связи';
    conn.className = 'conn bad';
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 1500);
  };
}
connect();
