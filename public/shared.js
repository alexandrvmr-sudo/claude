// Общие вычисления для пульта и экрана.

// Типы конкурсов: у каждого своя форма начисления баллов.
// choices — выбор одного варианта, marks — независимые галочки,
// counter — счётчик правильных ответов с ценой шага.
const KINDS = {
  free: { label: 'Обычный конкурс', hint: 'Баллы вводятся вручную' },
  blackbox: {
    label: 'Чёрный ящик',
    marks: [
      { id: 'live', label: 'Живое / неживое', points: 10 },
      { id: 'color', label: 'Цвет', points: 10 },
      { id: 'count', label: 'Количество', points: 10 },
      { id: 'what', label: 'Что это', points: 30 },
      { id: 'hand', label: 'Рискнул рукой', points: 10 },
    ],
  },
  roulette: {
    label: 'Русская рулетка',
    choices: [
      { id: 'hit', label: 'Угадал', points: 20 },
      { id: 'miss', label: 'Мимо', points: 0 },
    ],
  },
  books: {
    label: 'Книжный червь',
    choices: [
      { id: 'hit', label: 'Нашёл деньги', points: 30 },
      { id: 'miss', label: 'Пустая книга', points: 10 },
    ],
    marks: [{ id: 'bonus', label: 'Нашёл 50 ₽', points: 50 }],
  },
  glasses: {
    label: 'Стаканы',
    choices: [
      { id: 'win', label: 'Победный', points: 20 },
      { id: 'plain', label: 'Обычный', points: 5 },
      { id: 'poison', label: 'Отравленный', points: -10 },
      { id: 'refuse', label: 'Отказался', points: 0 },
    ],
  },
  blitz: {
    label: 'Блиц',
    counter: { step: 10, label: 'правильных ответов' },
  },
  final: {
    label: 'Финал',
    choices: [
      { id: 'hit', label: 'Угадал', points: 30 },
      { id: 'miss', label: 'Не угадал', points: 0 },
    ],
  },
};

window.MM = {
  KINDS,

  kindOf(contest) {
    const id = contest && contest.kind;
    return KINDS[id] ? id : 'free';
  },

  marksOf(state, pid, contestId) {
    return ((state.marks || {})[pid] || {})[contestId] || null;
  },

  // Балл из отметок. null — участник ещё не оценён.
  scoreFromMarks(kindId, mark) {
    const kind = KINDS[kindId];
    if (!kind || !mark) return null;
    let sum = 0;
    let any = false;
    if (kind.choices && mark.choice) {
      const chosen = kind.choices.find((c) => c.id === mark.choice);
      if (chosen) { sum += chosen.points; any = true; }
    }
    for (const m of kind.marks || []) {
      if (mark[m.id]) { sum += m.points; any = true; }
    }
    if (kind.counter && typeof mark.count === 'number') {
      sum += mark.count * kind.counter.step;
      any = true;
    }
    if (mark.zero) any = true; // «участвовал, но ничего не взял»
    return any ? sum : null;
  },

  // сумма баллов участника по всем конкурсам
  total(state, pid) {
    const row = state.scores[pid] || {};
    return state.contests.reduce((sum, c) => {
      const v = row[c.id];
      return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }, 0);
  },

  score(state, pid, contestId) {
    const v = (state.scores[pid] || {})[contestId];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  },

  revealKey(contestId, pid) {
    return `${contestId || 'total'}:${pid}`;
  },

  isRevealed(state, contestId, pid) {
    return !!state.display.reveal[this.revealKey(contestId, pid)];
  },

  // Настоящее место участника по сумме — без оглядки на то, что уже открыто.
  placeOf(state, pid) {
    const totals = state.participants.filter((p) => !p.hidden).map((p) => this.total(state, p.id));
    const mine = this.total(state, pid);
    return totals.filter((v) => v > mine).length + 1;
  },

  // Порядок строк на экране: раскрытые — по убыванию баллов,
  // нераскрытые уходят вниз в порядке регистрации (чтобы не выдать результат заранее).
  ordered(state, contestId) {
    const live = state.participants.filter((p) => !p.hidden);
    const withMeta = live.map((p, i) => {
      const revealed = this.isRevealed(state, contestId, p.id);
      const value = contestId ? this.score(state, p.id, contestId) : this.total(state, p.id);
      return { p, i, revealed, value: value === null ? 0 : value };
    });
    withMeta.sort((a, b) => {
      if (a.revealed !== b.revealed) return a.revealed ? -1 : 1;
      if (a.revealed && b.revealed && a.value !== b.value) return b.value - a.value;
      return a.i - b.i;
    });
    // место считаем только среди раскрытых, одинаковые баллы делят место
    let place = 0;
    let prev = null;
    let seen = 0;
    for (const item of withMeta) {
      if (!item.revealed) { item.place = null; continue; }
      seen += 1;
      if (prev === null || item.value !== prev) place = seen;
      item.place = place;
      prev = item.value;
    }
    return withMeta;
  },
};
