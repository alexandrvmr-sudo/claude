// Общие вычисления для пульта и экрана.
window.MM = {
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
