// Приложение «Волшебное зеркало» для macOS.
// Внутри поднимается тот же локальный сервер, а поверх него — два окна:
// пульт ведущего и экран зеркала, который уезжает на телевизор.

const { app, BrowserWindow, Menu, screen, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');

let serverApp = null;
let controlWindow = null;
let mirrorWindow = null;

const url = (page) => `http://127.0.0.1:${serverApp.port}/${page}`;

// Телевизор — это любой монитор, кроме основного
function externalDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id !== primary.id) || null;
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    title: 'Волшебное зеркало — пульт ведущего',
    backgroundColor: '#091518',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
    },
  });
  controlWindow.loadURL(url('admin.html'));
  controlWindow.on('closed', () => {
    controlWindow = null;
    closeMirror();
  });
}

function openMirror(displayId = null) {
  if (mirrorWindow) {
    mirrorWindow.focus();
    return;
  }
  const target = displayId
    ? screen.getAllDisplays().find((d) => d.id === displayId)
    : externalDisplay();
  const bounds = target ? target.bounds : screen.getPrimaryDisplay().bounds;

  mirrorWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    title: 'Волшебное зеркало',
    backgroundColor: '#02090b',
    frame: false,
    fullscreen: !!target, // на втором мониторе сразу во весь экран
    simpleFullscreen: true, // без отдельного рабочего стола macOS — так проще переключаться
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false, // иначе счётчик баллов начнёт подтормаживать в фоне
    },
  });
  mirrorWindow.loadURL(url('display.html'));
  mirrorWindow.on('closed', () => { mirrorWindow = null; });

  // окно на телевизоре не должно перехватывать работу с пультом
  if (target && controlWindow) setTimeout(() => controlWindow.focus(), 400);
}

function closeMirror() {
  if (mirrorWindow) {
    mirrorWindow.close();
    mirrorWindow = null;
  }
}

function toggleMirrorFullscreen() {
  if (!mirrorWindow) return;
  mirrorWindow.setFullScreen(!mirrorWindow.isFullScreen());
}

function chooseDisplay() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const names = displays.map((d, i) => {
    const kind = d.id === primary.id ? 'основной' : 'внешний';
    return `Монитор ${i + 1} — ${d.size.width}×${d.size.height} (${kind})`;
  });
  dialog.showMessageBox(controlWindow, {
    type: 'question',
    title: 'Куда вывести зеркало',
    message: 'На каком мониторе показать экран зеркала?',
    buttons: [...names, 'Отмена'],
    cancelId: names.length,
  }).then(({ response }) => {
    if (response < displays.length) {
      closeMirror();
      openMirror(displays[response].id);
    }
  });
}

function buildMenu() {
  const template = [
    {
      label: 'Волшебное зеркало',
      submenu: [
        {
          label: 'О программе',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: 'Волшебное зеркало',
            message: 'Волшебное зеркало',
            detail: 'Пульт ведущего и экран рейтинга для шоу.\n\n'
              + `Данные шоу: ${serverApp ? serverApp.dataDir : ''}`,
          }),
        },
        { type: 'separator' },
        { label: 'Скрыть', role: 'hide' },
        { label: 'Скрыть остальные', role: 'hideOthers' },
        { type: 'separator' },
        { label: 'Выйти', role: 'quit' },
      ],
    },
    {
      label: 'Экран зеркала',
      submenu: [
        { label: 'Открыть на телевизоре', accelerator: 'CmdOrCtrl+M', click: () => openMirror() },
        { label: 'Выбрать монитор…', click: () => chooseDisplay() },
        { label: 'Во весь экран', accelerator: 'CmdOrCtrl+Shift+F', click: () => toggleMirrorFullscreen() },
        { type: 'separator' },
        { label: 'Закрыть зеркало', click: () => closeMirror() },
      ],
    },
    {
      label: 'Шоу',
      submenu: [
        {
          label: 'Библиотека шоу',
          accelerator: 'CmdOrCtrl+L',
          click: () => controlWindow && controlWindow.webContents.executeJavaScript(
            `document.querySelector('.tab[data-tab="shows"]').click()`,
          ),
        },
        {
          label: 'Папка с данными',
          click: () => serverApp && shell.openPath(serverApp.dataDir),
        },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', role: 'undo' },
        { label: 'Повторить', role: 'redo' },
        { type: 'separator' },
        { label: 'Вырезать', role: 'cut' },
        { label: 'Копировать', role: 'copy' },
        { label: 'Вставить', role: 'paste' },
        { label: 'Выделить всё', role: 'selectAll' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { label: 'Свернуть', role: 'minimize' },
        { label: 'Перезагрузить пульт', accelerator: 'CmdOrCtrl+R', click: () => controlWindow && controlWindow.reload() },
        { type: 'separator' },
        { label: 'Инструменты разработчика', accelerator: 'Alt+CmdOrCtrl+I', click: () => {
          const win = BrowserWindow.getFocusedWindow();
          if (win) win.webContents.toggleDevTools();
        } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// В самопроверке рисуем программно: на машинах без видеокарты (сервер сборки)
// аппаратное ускорение роняет отрисовку.
if (process.env.MIRROR_SELFTEST) app.disableHardwareAcceleration();

// Второй запуск не поднимает вторую копию, а разворачивает уже открытую.
// Выходим сразу, не трогая сервер и окна, иначе две копии подерутся за данные.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on('second-instance', () => {
  if (controlWindow) {
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.focus();
  }
});

app.whenReady().then(async () => {
  try {
    const { startServer } = await import('../server.js');
    serverApp = await startServer({
      dataDir: app.getPath('userData'),
      port: 0, // свободный порт, чтобы не драться с другими программами
    });
  } catch (e) {
    dialog.showErrorBox('Не удалось запустить', String(e && e.message ? e.message : e));
    app.quit();
    return;
  }

  buildMenu();
  createControlWindow();

  app.on('activate', () => {
    if (!controlWindow) createControlWindow();
  });

  if (process.env.MIRROR_SELFTEST) selfTest();
});

// Проверка сборки: окна открываются, сервер внутри приложения отвечает,
// мостик до зеркала работает. Запуск: MIRROR_SELFTEST=1 <приложение>
async function selfTest() {
  const checks = [];
  const ok = (name, cond, extra = '') => checks.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const finish = (extra) => {
    if (extra) checks.push(extra);
    console.log('\n' + checks.join('\n') + '\n');
    app.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0);
  };
  // страховка: что бы ни зависло, результат всё равно попадёт в терминал
  const watchdog = setTimeout(() => finish('FAIL проверка зависла'), 90000);
  // окно на фоне может не отвечать — ждём ответа, но не бесконечно
  const ask = (win, code, timeout = 10000) => Promise.race([
    win.webContents.executeJavaScript(code, true).catch((e) => `ошибка: ${e.message}`),
    wait(timeout).then(() => 'не ответило'),
  ]);
  try {
    // Ждать did-finish-load нельзя: страницы держат открытый поток состояния (SSE),
    // и для Chromium загрузка не считается завершённой. Поэтому просто ждём разметку.
    const until = async (win, code, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        try {
          if (await win.webContents.executeJavaScript(code, true)) return true;
        } catch { /* страница ещё не готова */ }
        if (Date.now() > deadline) return false;
        await wait(300);
      }
    };
    await until(controlWindow, `!!document.querySelector('#shows')`);

    ok('пульт загрузился', controlWindow.webContents.getURL().includes('admin.html'));
    ok('интерфейс отрисовался', await ask(controlWindow, `!!document.querySelector('#shows')`));
    ok('мостик приложения доступен', await ask(controlWindow, `!!(window.mirrorApp && window.mirrorApp.isApp)`));
    ok('кнопка подписана под приложение',
      (await ask(controlWindow, `document.querySelector('#open-display').textContent`)) === 'Показать на телевизоре');
    ok('сервер внутри приложения отвечает', await ask(controlWindow, `fetch('/api/shows').then(r => r.json()).then(d => d.ok)`));

    await ask(controlWindow, `(() => {
      window.confirm = () => true; // в проверке некому нажимать «да»
      const f = document.querySelector('#add-show');
      f.name.value = 'Проверка сборки';
      f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); })()`);
    ok('шоу создаётся и сохраняется', await until(controlWindow,
      `document.querySelector('#brand-show').textContent === 'Проверка сборки'`, 10000));

    openMirror();
    await wait(300);
    if (mirrorWindow) await until(mirrorWindow, `!!document.querySelector('.mirror-glass')`);
    ok('зеркало открывается из приложения', !!mirrorWindow);
    if (mirrorWindow) {
      await wait(1200);
      ok('экран зеркала отрисовался', await ask(mirrorWindow, `!!document.querySelector('.mirror-glass')`));
      ok('ладонь на месте', await ask(mirrorWindow, `(() => { const i = document.querySelector('.hand'); return !!i && i.complete && i.naturalWidth > 0; })()`));
      // просим браузер действительно загрузить начертание: в режиме ожидания
      // оно может быть ещё не нужно странице, и простая проверка врёт
      const fonts = await ask(mirrorWindow, `Promise.all([
        document.fonts.load('300 20px Oswald'),
        document.fonts.load('300 20px Montserrat'),
      ]).then(([a, b]) => a.length > 0 && b.length > 0)`);
      ok('шрифты подхватились', fonts === true, fonts === true ? '' : String(fonts));
    }
  } catch (e) {
    ok('проверка прошла без ошибок', false, String(e && e.message ? e.message : e));
  }
  clearTimeout(watchdog);
  finish();
}

// Пульт просит показать зеркало
ipcMain.handle('mirror:open', () => { openMirror(); return true; });
ipcMain.handle('mirror:close', () => { closeMirror(); return true; });
ipcMain.handle('mirror:state', () => ({
  open: !!mirrorWindow,
  displays: screen.getAllDisplays().length,
}));

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  try {
    if (serverApp) serverApp.saveNow(); // дописываем последние правки
  } catch { /* выходим в любом случае */ }
});
