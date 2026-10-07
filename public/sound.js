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

  return {
    // настройки приходят с пульта
    configure(s) {
      settings = { on: s?.on !== false, volume: typeof s?.volume === 'number' ? s.volume : 0.7 };
      if (master) master.gain.value = settings.volume;
      if (!settings.on) this.ambient(false);
    },

    // браузер не даёт играть до первого действия пользователя — зовём после клика или клавиши
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume();
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

    // тихий гул зеркала в режиме ожидания
    ambient(on) {
      if (on && settings.on) {
        if (drone || !ensure() || ctx.state !== 'running') return;
        const g = ctx.createGain();
        g.gain.value = 0.0001;
        g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 2);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 320;
        const a = ctx.createOscillator();
        a.type = 'sine';
        a.frequency.value = 55;
        const b = ctx.createOscillator();
        b.type = 'sine';
        b.frequency.value = 82.5; // чистая квинта: гудит, но не давит
        a.connect(filter);
        b.connect(filter);
        filter.connect(g).connect(master);
        a.start();
        b.start();
        drone = { a, b, g };
      } else if (drone) {
        const { a, b, g } = drone;
        drone = null;
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1);
        a.stop(ctx.currentTime + 1.1);
        b.stop(ctx.currentTime + 1.1);
      }
    },
  };
})();
