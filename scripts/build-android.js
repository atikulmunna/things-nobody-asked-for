// Builds the Android app: refreshes the bundled web files, runs Gradle, and copies the APK to dist/.
// Usage: npm run android              (debug APK, WebView debugging on)
//        npm run android -- --release  (release APK for sharing, WebView debugging off)
//        npm run android -- --install  (also installs on a phone connected over USB)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const install = process.argv.includes('--install');
const release = process.argv.includes('--release');

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
  if (res.status !== 0) {
    console.error(`\n${cmd} failed with exit code ${res.status}.`);
    process.exit(res.status || 1);
  }
}

// Gradle needs JDK 21. Android Studio ships one, so use it when JAVA_HOME is not set.
function findJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const candidates = isWin
    ? ['C:\\Program Files\\Android\\Android Studio\\jbr']
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr')];
  return candidates.find((p) => fs.existsSync(p));
}

function findSdk() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  const p = isWin ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(os.homedir(), 'Library', 'Android', 'sdk');
  return fs.existsSync(p) ? p : null;
}

const javaHome = findJavaHome();
const sdk = findSdk();
if (!javaHome) console.warn('JAVA_HOME is not set and Android Studio was not found. Gradle may fail.');
if (!sdk) console.warn('Android SDK not found. Install Android Studio or set ANDROID_HOME.');

// Keep the vendored Capacitor runtime in step with the installed package.
fs.mkdirSync(path.join(ROOT, 'public', 'vendor'), { recursive: true });
const core = fs.readFileSync(path.join(ROOT, 'node_modules', '@capacitor', 'core', 'dist', 'index.js'), 'utf8');
fs.writeFileSync(path.join(ROOT, 'public', 'vendor', 'capacitor.js'), core.replace(/^\/\/# sourceMappingURL=.*$/m, ''));

run('npx', ['cap', 'sync', 'android'], { cwd: ROOT });

const env = { ...process.env };
if (javaHome) env.JAVA_HOME = javaHome;
if (sdk) env.ANDROID_HOME = sdk;
const androidDir = path.join(ROOT, 'android');
const gradlew = path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');
const variant = release ? 'release' : 'debug';
run(isWin ? `"${gradlew}"` : gradlew, [release ? 'assembleRelease' : 'assembleDebug', '--console=plain'], { cwd: androidDir, env });

const apk = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', release ? 'watchBoard.apk' : 'watchBoard-debug.apk');
fs.copyFileSync(apk, out);
console.log(`\nAPK ready: ${out}`);

if (install) {
  const adb = sdk ? path.join(sdk, 'platform-tools', isWin ? 'adb.exe' : 'adb') : 'adb';
  run(adb, ['install', '-r', out], { shell: false });
  run(adb, ['shell', 'am', 'start', '-n', 'dev.watchboard.app/.MainActivity'], { shell: false });
}
