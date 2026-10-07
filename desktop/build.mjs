// Сборка приложения для macOS.
// Запуск: node desktop/build.mjs [arm64|x64|both]
import packager from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const APP_NAME = 'Волшебное зеркало';

const arg = process.argv[2] || 'arm64';
const arches = arg === 'both' ? ['arm64', 'x64'] : [arg];

// В приложение кладём только то, что ему нужно для работы
const keep = ['package.json', 'server.js', 'public', 'desktop'];
const ignore = (filePath) => {
  if (!filePath) return false;
  const rel = filePath.replace(/^\//, '');
  if (!rel) return false;
  const top = rel.split('/')[0];
  return !keep.includes(top);
};

fs.mkdirSync(OUT, { recursive: true });

for (const arch of arches) {
  console.log(`\nСобираю для macOS ${arch}…`);
  const [appPath] = await packager({
    dir: ROOT,
    out: OUT,
    platform: 'darwin',
    arch,
    name: APP_NAME,
    executableName: 'magic-mirror', // имя бинарника латиницей — надёжнее
    icon: path.join(ROOT, 'desktop', 'icon.icns'),
    appBundleId: 'ru.magicmirror.show',
    appVersion: '1.0.0',
    appCategoryType: 'public.app-category.entertainment',
    darwinDarkModeSupport: true,
    overwrite: true,
    prune: false,
    ignore,
    extendInfo: {
      CFBundleName: APP_NAME,
      CFBundleDisplayName: APP_NAME,
      NSHighResolutionCapable: true,
      LSMinimumSystemVersion: '11.0',
    },
  });
  console.log('Готово:', appPath);

  const bundle = path.join(appPath, `${APP_NAME}.app`);

  // Имя в Finder и в меню: packager записывает сюда имя бинарника, поправляем
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  let plist = fs.readFileSync(plistPath, 'utf8');
  plist = plist.replace(
    /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${APP_NAME}$2`,
  );
  fs.writeFileSync(plistPath, plist);

  // Подпись «для себя» (ad-hoc): без неё macOS на Apple Silicon не запустит приложение.
  // Делается последней — подпись считается уже по готовому содержимому.
  try {
    execFileSync('rcodesign', ['sign', bundle], { stdio: 'inherit' });
    console.log('Подписано ad-hoc');
  } catch {
    console.warn('rcodesign не найден — приложение останется без подписи');
  }
}
