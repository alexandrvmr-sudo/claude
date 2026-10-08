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

  // --- турнир ---
  // Участники сражаются группами; из каждой группы дальше проходят лучшие.

  tour(state) {
    return state.tournament || { on: false, groupSize: 3, advance: 2, rounds: [], currentRoundId: null };
  },

  isTournament(state) {
    const t = this.tour(state);
    return !!t.on && t.rounds.length > 0;
  },

  currentRound(state) {
    const t = this.tour(state);
    return t.rounds.find((r) => r.id === t.currentRoundId) || t.rounds[t.rounds.length - 1] || null;
  },

  // конкурсы, относящиеся к туру (вне турнира — те, что без пометки)
  roundContests(state, roundId) {
    return state.contests.filter((c) => (roundId ? c.roundId === roundId : !c.roundId));
  },

  // сумма баллов участника за конкурсы одного тура
  roundScore(state, pid, roundId) {
    const row = state.scores[pid] || {};
    return this.roundContests(state, roundId).reduce((sum, c) => {
      const v = row[c.id];
      return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }, 0);
  },

  // все, кто участвует в туре
  roundMembers(state, round) {
    if (!round) return [];
    const ids = round.groups.flatMap((g) => g.members);
    return ids
      .map((pid) => state.participants.find((p) => p.id === pid))
      .filter(Boolean);
  },

  // Расклад внутри группы: по убыванию баллов, с местами и пометкой «проходит».
  // Пока тур не подведён, проходящими считаются лучшие по баллам — это подсказка ведущему.
  groupStanding(state, round, group) {
    const advance = this.tour(state).advance || 2;
    const rows = group.members
      .map((pid, i) => {
        const p = state.participants.find((x) => x.id === pid);
        return p ? { p, i, value: this.roundScore(state, pid, round.id) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (b.value - a.value) || (a.i - b.i));

    let place = 0;
    let prev = null;
    rows.forEach((row, idx) => {
      if (prev === null || row.value !== prev) place = idx + 1;
      row.place = place;
      prev = row.value;
      row.advances = round.finished
        ? (round.advancing || []).includes(row.p.id)
        : idx < advance;
      // ничья на границе отсечения: ведущему придётся решать вручную
      row.tie = idx === advance - 1 && rows[idx + 1] && rows[idx + 1].value === row.value;
    });
    return rows;
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
    // у конкурса тура своя «аудитория» — только те, кто в этом туре
    const contest = contestId ? state.contests.find((c) => c.id === contestId) : null;
    const round = contest && contest.roundId
      ? this.tour(state).rounds.find((r) => r.id === contest.roundId)
      : null;
    const live = round
      ? this.roundMembers(state, round).filter((p) => !p.hidden)
      : state.participants.filter((p) => !p.hidden);
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
