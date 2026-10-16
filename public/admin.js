// Пульт ведущего: правит состояние и отправляет его на сервер,
// сервер раздаёт изменения экрану зеркала (и другим открытым пультам).

let state = null;
let myRev = -1; // чтобы не перерисовывать пульт от собственного эха
let pending = 0; // сколько наших отправок ещё в пути

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
  pending += 1;
  try {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    const data = await res.json();
    if (data.rev) myRev = Math.max(myRev, data.rev);
  } catch {
    conn.textContent = 'нет связи с сервером';
    conn.className = 'conn bad';
  } finally {
    pending -= 1;
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
  { id: 'task', label: 'Задание' },
  { id: 'leaderboard', label: 'Общий рейтинг' },
  { id: 'contest', label: 'Итоги конкурса' },
  { id: 'spotlight', label: 'Один участник' },
  { id: 'winner', label: 'Победитель' },
  { id: 'draw', label: 'Жеребьёвка' },
  { id: 'quiz', label: 'Блиц' },
  { id: 'prophecy', label: 'Предсказание' },
];

function renderModes() {
  const host = $('#modes');
  host.innerHTML = '';
  for (const m of MODES) {
    const b = el('button', 'btn', m.label);
    if (state.display.mode === m.id) b.classList.add('is-active', 'btn-gold');
    b.addEventListener('click', () => {
      state.display.mode = m.id;
      if ((m.id === 'contest' || m.id === 'task') && !state.display.contestId && state.contests[0]) {
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
  $('#contest-picker').hidden = !['contest', 'task'].includes(state.display.mode);

  const nowTrack = $('#now-track');
  if (nowTrack) {
    const d = state.display;
    const taskOn = (d.sound?.taskMusic?.on) !== false;
    if (d.mode === 'standby' || d.mode === 'prophecy') {
      nowTrack.textContent = (d.sound?.music?.on) === false
        ? 'Музыка ожидания выключена.'
        : 'Играет музыка ожидания (public/music/standby.mp3).';
    } else if (d.mode === 'task' || d.mode === 'contest') {
      const file = trackForContest(d.contestId);
      nowTrack.textContent = !taskOn ? 'Музыка заданий выключена в «Настройках».'
        : file ? `Играет: ${file}`
          : 'Музыки для этого конкурса нет: положите файлы в public/music/tasks.';
    } else if (!taskOn) {
      nowTrack.textContent = 'Музыка заданий выключена в «Настройках».';
    } else {
      const file = trackForContest(d.contestId) || taskTracks[0];
      nowTrack.textContent = file
        ? `Играет: ${file}`
        : 'Играет музыка ожидания: файлов заданий в папке нет.';
    }
  }
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
  const live = () => state.participants.filter((p) => !p.hidden);
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

    // тип конкурса решает, как пульт начисляет баллы
    const kindSel = el('select', 'kind-select');
    for (const [id, kind] of Object.entries(MM.KINDS)) {
      const o = el('option', null, kind.label);
      o.value = id;
      if (id === MM.kindOf(c)) o.selected = true;
      kindSel.appendChild(o);
    }
    kindSel.addEventListener('change', () => { c.kind = kindSel.value; push(); });
    row.appendChild(kindSel);

    row.appendChild(musicSelect(c));

    const show = el('button', 'btn small btn-gold', 'Задание на экран');
    show.addEventListener('click', () => {
      state.display.mode = 'task';
      state.display.contestId = c.id;
      push();
    });
    const results = el('button', 'btn small', 'Итоги на экран');
    results.addEventListener('click', () => {
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
      for (const pid of Object.keys(state.marks || {})) delete state.marks[pid][c.id];
      for (const key of Object.keys(state.display.reveal)) {
        if (key.startsWith(`${c.id}:`)) delete state.display.reveal[key];
      }
      if (state.display.contestId === c.id) state.display.contestId = null;
      push();
    });
    row.append(show, results, up, del);

    const card = el('div', 'contest-card');
    card.appendChild(row);

    // описание задания — то, что увидят гости на экране
    const about = el('textarea');
    about.rows = 2;
    about.placeholder = 'Описание задания: что делают участники. Покажется на экране под названием.';
    about.value = c.description || '';
    about.addEventListener('change', () => {
      const text = about.value.trim();
      if (text) c.description = text;
      else delete c.description;
      push();
    });
    card.appendChild(about);

    // у блица свой список вопросов: строка «вопрос | ответ»
    if (MM.kindOf(c) === 'blitz') {
      const quiz = el('textarea');
      quiz.rows = 6;
      quiz.placeholder = 'Вопросы блица, по одному в строке: вопрос | ответ';
      quiz.value = (c.questions || []).map((q) => `${q.q} | ${q.a}`).join('\n');
      quiz.addEventListener('change', () => {
        c.questions = quiz.value.split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [q, ...rest] = line.split('|');
            return { q: q.trim(), a: rest.join('|').trim() };
          })
          .filter((q) => q.q);
        push();
      });
      card.appendChild(quiz);
      card.appendChild(el('p', 'hint', `Вопросов: ${(c.questions || []).length}. Разделитель — вертикальная черта.`));
    }

    host.appendChild(card);
  });
}

// --- таблица баллов ---
// --- баллы ---
// У каждого конкурса своя форма начисления: галочки чёрного ящика,
// выбор стакана, счётчик блица. Пульт считает сумму и кладёт её в scores.

function markOf(pid, contestId) {
  state.marks = state.marks || {};
  state.marks[pid] = state.marks[pid] || {};
  state.marks[pid][contestId] = state.marks[pid][contestId] || {};
  return state.marks[pid][contestId];
}

function applyMarks(pid, contestId, kindId) {
  const value = MM.scoreFromMarks(kindId, (state.marks[pid] || {})[contestId]);
  state.scores[pid] = state.scores[pid] || {};
  state.scores[pid][contestId] = value;
  push();
}

function clearMarks(pid, contestId) {
  if (state.marks && state.marks[pid]) delete state.marks[pid][contestId];
  if (state.scores[pid]) state.scores[pid][contestId] = null;
  push();
}

function scoreContest() {
  const sel = $('#score-contest');
  return state.contests.find((c) => c.id === sel.value) || state.contests[0] || null;
}

function kindHint(kindId) {
  const kind = MM.KINDS[kindId];
  if (!kind) return '';
  const parts = [];
  for (const ch of kind.choices || []) parts.push(`${ch.label} ${ch.points > 0 ? '+' : ''}${ch.points}`);
  for (const m of kind.marks || []) parts.push(`${m.label} +${m.points}`);
  if (kind.counter) parts.push(`каждый правильный ответ +${kind.counter.step}`);
  return parts.length ? `${kind.label}: ${parts.join(' · ')}` : kind.hint || kind.label;
}

function scoreCard(p, contest, kindId) {
  const kind = MM.KINDS[kindId];
  const mark = MM.marksOf(state, p.id, contest.id) || {};
  const card = el('div', 'score-card');
  card.appendChild(el('div', 'score-name', p.name || 'Без имени'));

  const controls = el('div', 'score-controls');

  if (kindId === 'free') {
    const input = el('input', 'score-free');
    input.type = 'number';
    input.step = 'any';
    input.value = MM.score(state, p.id, contest.id) ?? '';
    input.addEventListener('input', () => {
      state.scores[p.id] = state.scores[p.id] || {};
      const raw = input.value.trim();
      state.scores[p.id][contest.id] = raw === '' ? null : Number(raw);
      pushQuiet();
    });
    controls.appendChild(input);
  }

  for (const ch of kind.choices || []) {
    const b = el('button', 'btn chip', `${ch.label} ${ch.points > 0 ? '+' : ''}${ch.points}`);
    if (mark.choice === ch.id) b.classList.add('is-active', 'btn-gold');
    if (ch.points < 0) b.classList.add('chip-bad');
    b.addEventListener('click', () => {
      const m = markOf(p.id, contest.id);
      m.choice = m.choice === ch.id ? null : ch.id;
      delete m.zero;
      applyMarks(p.id, contest.id, kindId);
    });
    controls.appendChild(b);
  }

  for (const mk of kind.marks || []) {
    const b = el('button', 'btn chip', `${mk.label} +${mk.points}`);
    if (mark[mk.id]) b.classList.add('is-active', 'btn-gold');
    b.addEventListener('click', () => {
      const m = markOf(p.id, contest.id);
      m[mk.id] = !m[mk.id];
      delete m.zero;
      applyMarks(p.id, contest.id, kindId);
    });
    controls.appendChild(b);
  }

  if (kind.counter) {
    const minus = el('button', 'btn chip', '−');
    const plus = el('button', 'btn chip btn-gold', `+${kind.counter.step}`);
    const count = el('span', 'score-count', `${mark.count || 0} ${kind.counter.label}`);
    minus.addEventListener('click', () => {
      const m = markOf(p.id, contest.id);
      m.count = Math.max(0, (m.count || 0) - 1);
      applyMarks(p.id, contest.id, kindId);
    });
    plus.addEventListener('click', () => {
      const m = markOf(p.id, contest.id);
      m.count = (m.count || 0) + 1;
      applyMarks(p.id, contest.id, kindId);
    });
    controls.append(minus, count, plus);
  }

  if (kindId !== 'free') {
    const zero = el('button', 'btn chip', 'Ничего');
    if (mark.zero) zero.classList.add('is-active');
    zero.addEventListener('click', () => {
      state.marks[p.id] = state.marks[p.id] || {};
      state.marks[p.id][contest.id] = { zero: true };
      applyMarks(p.id, contest.id, kindId);
    });
    controls.appendChild(zero);
  }

  const clear = el('button', 'btn chip', 'Сброс');
  clear.addEventListener('click', () => clearMarks(p.id, contest.id));
  controls.appendChild(clear);

  card.appendChild(controls);

  const value = MM.score(state, p.id, contest.id);
  const sum = el('div', 'score-sum', value === null ? '—' : String(value));
  if (value !== null && value < 0) sum.classList.add('is-bad');
  card.appendChild(sum);
  return card;
}

// --- блиц ---
// Вопросы хранятся у конкурса, пульт листает их и выводит на зеркало.
function quizState() {
  state.display.quiz = state.display.quiz || { contestId: null, index: 0, revealed: false };
  return state.display.quiz;
}

function quizList(contest) {
  return (contest && contest.questions) || [];
}

function quizStep(delta) {
  const contest = scoreContest();
  const list = quizList(contest);
  if (!list.length) return;
  const q = quizState();
  if (q.contestId !== contest.id) q.index = 0;
  q.contestId = contest.id;
  q.index = Math.max(0, Math.min(list.length - 1, (q.index || 0) + delta));
  q.revealed = false;
  state.display.mode = 'quiz';
  push();
}

function renderQuiz(contest) {
  const box = $('#quiz-box');
  const isQuiz = contest && MM.kindOf(contest) === 'blitz';
  box.hidden = !isQuiz;
  if (!isQuiz) return;

  const list = quizList(contest);
  const q = quizState();
  const index = q.contestId === contest.id ? Math.max(0, Math.min(list.length - 1, q.index || 0)) : 0;
  const item = list[index];
  $('#quiz-count').textContent = list.length
    ? `Вопрос ${index + 1} из ${list.length}`
    : 'Вопросов нет: впишите их на вкладке «Конкурсы».';
  $('#quiz-q').textContent = item ? item.q : '—';
  const answer = $('#quiz-a');
  answer.textContent = item ? (q.revealed && q.contestId === contest.id ? item.a : 'Ответ скрыт') : '';
  answer.classList.toggle('is-open', !!(item && q.revealed && q.contestId === contest.id));
}

$('#quiz-next').addEventListener('click', () => quizStep(1));
$('#quiz-prev').addEventListener('click', () => quizStep(-1));
$('#quiz-answer').addEventListener('click', () => {
  const contest = scoreContest();
  const q = quizState();
  q.contestId = contest ? contest.id : null;
  q.revealed = !q.revealed;
  push();
});
$('#quiz-screen').addEventListener('click', () => {
  const contest = scoreContest();
  if (!contest) return;
  const q = quizState();
  if (q.contestId !== contest.id) { q.contestId = contest.id; q.index = 0; }
  q.revealed = false;
  state.display.mode = 'quiz';
  push();
});

function renderScoreCards() {
  const sel = $('#score-contest');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const c of state.contests) {
    const o = el('option', null, c.name || 'Без названия');
    o.value = c.id;
    sel.appendChild(o);
  }
  if (prev && state.contests.some((c) => c.id === prev)) sel.value = prev;

  const host = $('#score-cards');
  host.innerHTML = '';
  const contest = scoreContest();
  if (!contest) {
    $('#score-kind').textContent = 'Сначала добавьте конкурс.';
    renderQuiz(null);
    return;
  }
  const kindId = MM.kindOf(contest);
  $('#score-kind').textContent = kindHint(kindId);
  renderQuiz(contest);

  if (!state.participants.length) {
    host.appendChild(el('p', 'hint', 'Сначала добавьте участников.'));
    return;
  }

  // если для этого конкурса была жеребьёвка — раскладываем по тройкам
  const dr = state.draw || {};
  const blocks = (dr.kind === 'groups' && dr.contestId === contest.id && (dr.groups || []).length)
    ? dr.groups.map((g, i) => ({ title: `Тройка ${i + 1}`, ids: g }))
    : [{ title: '', ids: state.participants.map((p) => p.id) }];

  for (const block of blocks) {
    if (block.title) host.appendChild(el('div', 'score-group-title', block.title));
    for (const pid of block.ids) {
      const p = state.participants.find((x) => x.id === pid);
      if (p) host.appendChild(scoreCard(p, contest, kindId));
    }
  }
}

// Общий зачёт: таблица только для чтения, правки идут карточками выше.
function renderScores() {
  renderScoreCards();
  const table = $('#score-table');
  table.innerHTML = '';

  const head = table.insertRow();
  head.appendChild(el('th', null, 'Участник'));
  for (const c of state.contests) head.appendChild(el('th', null, c.name));
  head.appendChild(el('th', null, 'Сумма'));

  for (const p of state.participants) {
    const tr = table.insertRow();
    tr.appendChild(el('td', 'who', p.name || 'Без имени'));
    for (const c of state.contests) {
      const v = MM.score(state, p.id, c.id);
      const td = el('td', 'score-cell', v === null ? '—' : String(v));
      if (v !== null && v < 0) td.classList.add('is-bad');
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

$('#score-contest').addEventListener('change', renderScoreCards);

// отправка без полной перерисовки (для полей ввода баллов)
let quietTimer = null;
function pushQuiet() {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(async () => {
    pending += 1;
    try {
      const res = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      const data = await res.json();
      if (data.rev) myRev = Math.max(myRev, data.rev);
      renderTotalsOnly();
      renderReveal();
    } catch { /* сеть отвалилась — состояние останется локальным до следующей правки */ } finally {
      pending -= 1;
    }
  }, 250);
}

// Обновляем цифры в общем зачёте, не перерисовывая таблицу целиком:
// так не прыгает фокус из поля ввода.
function renderTotalsOnly() {
  const rows = $('#score-table').rows;
  state.participants.forEach((p, i) => {
    const row = rows[i + 1];
    if (!row) return;
    state.contests.forEach((c, j) => {
      const cell = row.cells[j + 1];
      if (!cell) return;
      const v = MM.score(state, p.id, c.id);
      cell.textContent = v === null ? '—' : String(v);
      cell.classList.toggle('is-bad', v !== null && v < 0);
    });
    const last = row.cells[row.cells.length - 1];
    if (last) last.textContent = String(MM.total(state, p.id));
  });
}

// --- жеребьёвка ---
// Разыгрывает пульт: экран только показывает результат барабаном.

function drawState() {
  state.draw = state.draw || { runId: 0, kind: 'groups', contestId: null, groups: [], order: [], finalists: [], calls: [] };
  return state.draw;
}

function shuffled(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 10 человек делим на тройки: лишние расходятся по группам, чтобы
// получилось 3+3+4, а не 3+3+3+1.
function splitByThree(ids) {
  const count = Math.max(1, Math.floor(ids.length / 3));
  const groups = Array.from({ length: count }, () => []);
  shuffled(ids).forEach((pid, i) => groups[i % count].push(pid));
  return groups;
}

function playingIds() {
  return state.participants.filter((p) => !p.hidden && !p.out).map((p) => p.id);
}

function drawContestId() {
  const sel = $('#draw-contest');
  return sel.value || (state.contests[0] ? state.contests[0].id : null);
}

function runDraw(kind) {
  const ids = playingIds();
  if (ids.length < 2) { alert('Сначала добавьте участников.'); return; }
  const dr = drawState();
  dr.kind = kind;
  dr.contestId = drawContestId();
  dr.runId = (dr.runId || 0) + 1;
  if (kind === 'groups') {
    dr.groups = splitByThree(ids);
    dr.order = [];
  } else {
    dr.order = shuffled(ids);
    dr.groups = [];
  }
  state.display.mode = 'draw';
  push();
}

function finalistIds() {
  return [$('#final-a').value, $('#final-b').value].filter(Boolean);
}

function callToFinalist(which) {
  const dr = drawState();
  const finalists = finalistIds();
  if (finalists.length < 2) { alert('Сначала выберите двух финалистов.'); return; }
  const finalist = finalists[which];
  if ((dr.calls || []).some((c) => c.finalist === finalist)) {
    if (!confirm('К этому финалисту уже выходил участник. Вызвать ещё одного?')) return;
  }
  const used = new Set((dr.calls || []).map((c) => c.guest));
  const pool = playingIds().filter((pid) => !finalists.includes(pid) && !used.has(pid));
  if (!pool.length) { alert('Свободных участников не осталось.'); return; }
  dr.kind = 'final';
  dr.finalists = finalists;
  dr.calls = [...(dr.calls || []), { finalist, guest: pool[Math.floor(Math.random() * pool.length)] }];
  dr.runId = (dr.runId || 0) + 1;
  state.display.mode = 'draw';
  push();
}

function renderDraw() {
  const sel = $('#draw-contest');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const c of state.contests) {
    const o = el('option', null, c.name || 'Без названия');
    o.value = c.id;
    sel.appendChild(o);
  }
  if (prev && state.contests.some((c) => c.id === prev)) sel.value = prev;
  else if (state.draw && state.draw.contestId) sel.value = state.draw.contestId;

  for (const id of ['#final-a', '#final-b']) {
    const box = $(id);
    const was = box.value;
    box.innerHTML = '';
    const none = el('option', null, '— не выбран —');
    none.value = '';
    box.appendChild(none);
    for (const p of state.participants) {
      const o = el('option', null, p.name || 'Без имени');
      o.value = p.id;
      box.appendChild(o);
    }
    box.value = was;
  }

  const dr = state.draw || {};
  const name = (pid) => {
    const p = state.participants.find((x) => x.id === pid);
    return p ? (p.name || 'Без имени') : '—';
  };
  const host = $('#draw-result');
  host.innerHTML = '';
  if (dr.kind === 'groups' && (dr.groups || []).length) {
    dr.groups.forEach((g, i) => {
      host.appendChild(el('div', 'draw-line', `Тройка ${i + 1}: ${g.map(name).join(', ')}`));
    });
  } else if (dr.kind === 'order' && (dr.order || []).length) {
    dr.order.forEach((pid, i) => host.appendChild(el('div', 'draw-line', `${i + 1}. ${name(pid)}`)));
  } else if (dr.kind === 'final' && (dr.calls || []).length) {
    for (const call of dr.calls) {
      host.appendChild(el('div', 'draw-line', `К ${name(call.finalist)} вышел ${name(call.guest)}`));
    }
  }

  const contest = state.contests.find((c) => c.id === dr.contestId);
  $('#draw-status').textContent = dr.runId
    ? `Последняя жеребьёвка${contest ? ` для «${contest.name}»` : ''}. Чтобы переиграть, нажмите кнопку ещё раз.`
    : 'Жеребьёвки ещё не было.';
  const left = playingIds().filter((pid) => !finalistIds().includes(pid)
    && !(dr.calls || []).some((c) => c.guest === pid)).length;
  $('#final-status').textContent = finalistIds().length < 2
    ? 'Выберите двух финалистов — они не будут выпадать в розыгрыше.'
    : `Вызовов сделано: ${(dr.calls || []).length}. Свободных участников: ${left}.`;
}

$('#draw-groups').addEventListener('click', () => runDraw('groups'));
$('#draw-order').addEventListener('click', () => runDraw('order'));
$('#draw-show').addEventListener('click', () => {
  state.display.mode = 'draw';
  drawState().runId = (drawState().runId || 0) + 1; // крутим барабан заново
  push();
});
$('#draw-contest').addEventListener('change', () => { drawState().contestId = drawContestId(); push(); });
$('#final-a').addEventListener('change', renderDraw);
$('#final-b').addEventListener('change', renderDraw);
$('#final-top').addEventListener('click', () => {
  const top = [...state.participants]
    .filter((p) => !p.hidden)
    .sort((a, b) => MM.total(state, b.id) - MM.total(state, a.id))
    .slice(0, 2);
  if (top.length < 2) { alert('Нужны хотя бы два участника с баллами.'); return; }
  $('#final-a').value = top[0].id;
  $('#final-b').value = top[1].id;
  drawState().finalists = [top[0].id, top[1].id];
  push();
});
$('#final-call-a').addEventListener('click', () => callToFinalist(0));
$('#final-call-b').addEventListener('click', () => callToFinalist(1));
$('#final-reset').addEventListener('click', () => {
  const dr = drawState();
  dr.calls = [];
  dr.runId = (dr.runId || 0) + 1;
  push();
});

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

// --- предсказания ---
function proph() {
  state.prophecies = state.prophecies || { list: [], used: [] };
  if (!Array.isArray(state.prophecies.list)) state.prophecies.list = [];
  if (!Array.isArray(state.prophecies.used)) state.prophecies.used = [];
  return state.prophecies;
}

function prophecyPool() {
  const p = proph();
  const list = p.list.map((t) => String(t).trim()).filter(Boolean);
  const used = new Set(p.used);
  const fresh = list.filter((t) => !used.has(t));
  return { list, fresh };
}

function renderProphecy() {
  const p = proph();
  const { list, fresh } = prophecyPool();
  const area = $('#prophecy-list');
  if (document.activeElement !== area) area.value = p.list.join('\n');
  $('#prophecy-who').placeholder = 'Например: Ирина';
  $('#prophecy-status').textContent = list.length
    ? `В списке ${list.length}, осталось нетронутых — ${fresh.length}.`
    : 'Список пуст: впишите предсказания ниже или верните заготовки.';
  const cur = state.display.prophecy || {};
  $('#prophecy-current').textContent = cur.text
    ? `На экране: ${cur.who ? `${cur.who} — ` : ''}«${cur.text}»`
    : '';
}

$('#prophecy-save').addEventListener('click', () => {
  proph().list = $('#prophecy-list').value.split('\n').map((t) => t.trim()).filter(Boolean);
  proph().used = proph().used.filter((t) => proph().list.includes(t));
  push();
});

$('#prophecy-default').addEventListener('click', async () => {
  if (!confirm('Вернуть заготовленные предсказания? Ваш список будет заменён.')) return;
  const r = await fetch('/api/prophecies/default');
  const data = await r.json();
  if (!data.ok) return;
  proph().list = data.list;
  proph().used = [];
  push();
});

$('#prophecy-reset').addEventListener('click', () => { proph().used = []; push(); });

$('#prophecy-draw').addEventListener('click', () => {
  const { list, fresh } = prophecyPool();
  if (!list.length) { alert('Список предсказаний пуст.'); return; }
  let pool = fresh;
  if (!pool.length) { proph().used = []; pool = list; } // круг замкнулся — начинаем заново
  const text = pool[Math.floor(Math.random() * pool.length)];
  proph().used.push(text);
  state.display.mode = 'prophecy';
  state.display.prophecy = { text, who: $('#prophecy-who').value.trim() };
  push();
});

$('#prophecy-again').addEventListener('click', () => {
  const cur = state.display.prophecy || {};
  if (!cur.text) { alert('Сначала вытяните предсказание.'); return; }
  state.display.mode = 'prophecy';
  push();
});

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
  renderDraw();
  renderProphecy();
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
    // Своё же эхо и всё, что старше наших отправок, пропускаем: иначе быстрые
    // нажатия подряд затирались бы ответом на предыдущее нажатие.
    if (pending > 0 || incoming.rev <= myRev) return;
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
