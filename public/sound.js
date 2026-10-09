// Звуки зеркала. Ничего не скачиваем: всё синтезируется прямо в браузере
// через Web Audio, поэтому программа остаётся офлайновой и без лишних файлов.
window.MMSound = (() => {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let drone = null;
  let settings = { on: true, volume: 0.7 };

  function ensure() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(ctx.destination);
    return ctx;
  }

  function noise() {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 1.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // одна нота: тип волны, частота, громкость и форма затухания
  function tone({ type = 'sine', freq = 440, gain = 0.2, attack = 0.004, decay = 0.3, at = 0, glide = 0 }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, glide), t + decay);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
    return osc;
  }

  // шумовой пласт через фильтр — из него делаем «вздохи» и шелест
  function hiss({ gain = 0.1, decay = 0.5, from = 2400, to = 300, q = 1.2, at = 0 }) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noise();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(filter).connect(g).connect(master);
    src.start(t);
    src.stop(t + decay + 0.05);
  }

  const voices = {
    // щелчок счётчика: чем ближе к финалу, тем выше
    tick(progress = 0) {
      tone({ type: 'triangle', freq: 420 + progress * 760, gain: 0.09, decay: 0.055 });
    },
    // удар в момент остановки счётчика
    strike() {
      tone({ type: 'sine', freq: 110, gain: 0.5, decay: 1.4 });
      tone({ type: 'sine', freq: 220, gain: 0.22, decay: 1.1 });
      [660, 988, 1320].forEach((f, i) => tone({ type: 'sine', freq: f, gain: 0.14 - i * 0.03, decay: 1.6 - i * 0.3 }));
      hiss({ gain: 0.16, decay: 1.2, from: 5200, to: 700 });
    },
    // открыли оценку в списке
    reveal() {
      tone({ type: 'sine', freq: 420, glide: 980, gain: 0.16, decay: 0.3 });
      tone({ type: 'sine', freq: 1320, gain: 0.1, decay: 0.7, at: 0.12 });
      hiss({ gain: 0.07, decay: 0.35, from: 3600, to: 900 });
    },
    // смена картинки на экране
    whoosh() {
      hiss({ gain: 0.13, decay: 0.6, from: 3200, to: 260, q: 0.8 });
      tone({ type: 'sine', freq: 320, glide: 120, gain: 0.08, decay: 0.5 });
    },
    // победитель
    fanfare() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone({ type: 'triangle', freq: f, gain: 0.2, decay: 0.55, at: i * 0.14 });
        tone({ type: 'sine', freq: f * 2, gain: 0.07, decay: 0.4, at: i * 0.14 });
      });
      hiss({ gain: 0.1, decay: 1.4, from: 6000, to: 1200, at: 0.4 });
    },
    // выбывание участника
    fail() {
      tone({ type: 'sawtooth', freq: 180, glide: 70, gain: 0.16, decay: 0.8 });
    },
  };

  // --- музыка ---
  // Один движок на всю музыку: и заставка, и треки заданий. Короткая запись
  // зацикливается двумя проигрывателями с плавной склейкой, а смена трека
  // идёт через затухание, чтобы в эфире не было рывка.
  const CROSSFADE = 1.4; // секунд на склейку петли
  const PRESTART = 0.8; // за сколько до склейки будить второй проигрыватель
  let music = null;

  function ensureMusic() {
    if (music) return music;
    const make = () => {
      const el = new Audio();
      el.preload = 'auto';
      el.volume = 0;
      el.hidden = true;
      document.body.appendChild(el); // в документе — чтобы браузер вёл себя предсказуемо
      return el;
    };
    music = {
      els: [make(), make()],
      active: 0,
      want: 0, // к какой громкости идём сейчас
      gain: 0, // текущая громкость
      timer: 0,
      src: null, // что играет
      nextSrc: null, // на что переключаемся, когда затухнем
      nextWant: 0,
    };
    return music;
  }

  function applySrc(src) {
    const m = music;
    for (const el of m.els) {
      el.pause();
      el.volume = 0;
      if (el.getAttribute('src') !== src) {
        el.src = src;
        el.load();
      }
      el.currentTime = 0;
    }
    m.active = 0;
    m.src = src;
  }

  function start() {
    const m = music;
    if (!m.src) return;
    const el = m.els[m.active];
    if (el.paused) el.play().catch(() => { /* браузер ещё не разрешил звук */ });
  }

  function tickMusic() {
    const m = music;
    if (!m) return;

    // плавно появляемся и затухаем, примерно за секунду
    const step = 0.04;
    if (m.gain < m.want) m.gain = Math.min(m.want, m.gain + step);
    else if (m.gain > m.want) m.gain = Math.max(m.want, m.gain - step);

    if (m.gain <= 0 && m.want <= 0) {
      for (const el of m.els) {
        if (!el.paused) el.pause();
        el.volume = 0;
      }
      // затухли ради смены трека — ставим новый и поднимаемся обратно
      if (m.nextSrc) {
        applySrc(m.nextSrc);
        m.nextSrc = null;
        m.want = m.nextWant;
        start();
        return;
      }
      clearInterval(m.timer);
      m.timer = 0;
      return;
    }

    const cur = m.els[m.active];
    const other = m.els[1 - m.active];
    const dur = cur.duration;
    let mix = 1;

    if (Number.isFinite(dur) && dur > CROSSFADE * 2) {
      // Запускаем второй проигрыватель заранее и беззвучно: ему нужно время
      // раскрутиться, иначе на стыке получится провал.
      if (cur.currentTime > dur - (CROSSFADE + PRESTART) && other.paused && m.want > 0) {
        other.currentTime = 0;
        other.volume = 0;
        other.play().catch(() => {});
      }
      if (cur.currentTime > dur - CROSSFADE) {
        mix = Math.max(0, (dur - cur.currentTime) / CROSSFADE);
      }
    }

    cur.volume = m.gain * mix;
    other.volume = m.gain * (1 - mix);

    // старый проигрыватель доиграл — меняем их местами
    if (cur.ended || (Number.isFinite(dur) && cur.currentTime >= dur - 0.05)) {
      cur.pause();
      cur.currentTime = 0;
      cur.volume = 0;
      m.active = 1 - m.active;
    }
  }

  return {
    // настройки приходят с пульта
    configure(s) {
      settings = { on: s?.on !== false, volume: typeof s?.volume === 'number' ? s.volume : 0.7 };
      if (master) master.gain.value = settings.volume;
      if (!settings.on && music) music.want = 0; // общий выключатель гасит и музыку
    },

    // браузер не даёт играть до первого действия пользователя — зовём после клика или клавиши
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume();
      this.resumeMusic();
      return this.ready();
    },

    ready() {
      return !!ctx && ctx.state === 'running';
    },

    play(name, arg) {
      if (!settings.on) return;
      if (!ensure() || ctx.state !== 'running') return;
      const voice = voices[name];
      if (voice) voice(arg);
    },

    // Щелчки счётчика расписываем заранее по звуковым часам: так ритм не зависит
    // от частоты кадров и точно совпадает с замедлением числа к финалу.
    countdown(target, durationMs) {
      const silent = { cancel() {} };
      if (!settings.on || !ensure() || ctx.state !== 'running') return silent;
      const total = Math.abs(Math.round(target));
      if (!total) return silent;
      const step = Math.max(1, Math.ceil(total / 60)); // не больше ~60 щелчков
      const nodes = [];
      for (let k = step; k <= total; k += step) {
        const progress = k / total;
        // обратная функция к замедлению из display.js: value = target * (1 - (1-t)^3)
        const at = (durationMs / 1000) * (1 - (1 - progress) ** (1 / 3));
        nodes.push(tone({ type: 'triangle', freq: 420 + progress * 760, gain: 0.09, decay: 0.055, at }));
      }
      return {
        cancel() {
          for (const n of nodes) {
            try { n.stop(); } catch { /* уже отыграл */ }
          }
        },
      };
    },

    // Что играет сейчас: src — адрес файла, пусто — тишина.
    // Смена трека идёт через затухание, громкость меняется на лету.
    music({ src = null, on = true, volume = 0.6 } = {}) {
      const target = on && settings.on && src ? Math.max(0, Math.min(1, volume)) : 0;
      if (!music && !target) return; // нечего включать и нечего гасить
      const m = ensureMusic();
      m.nextWant = target;

      if (!target) {
        m.want = 0;
        m.nextSrc = null;
      } else if (src !== m.src) {
        if (m.gain > 0) {
          m.nextSrc = src; // сначала затухнем, потом поставим новый
          m.want = 0;
        } else {
          applySrc(src);
          m.want = target;
          start();
        }
      } else {
        m.want = target;
        m.nextSrc = null;
        start();
      }

      if (!m.timer) m.timer = setInterval(tickMusic, 40);
    },

    // звук разрешили позже — пробуем доиграть
    resumeMusic() {
      if (music && music.want > 0) start();
    },
  };
})();
