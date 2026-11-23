// Builds the Android app: refreshes the bundled web files, runs Gradle, and copies the APK to dist/.
// Usage: npm run android              (debug APK, WebView debugging on)
//        npm run android -- --release  (release APK for sharing: WebView debugging off, release key)
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

// Gradle needs JDK 21. When JAVA_HOME is not set, use the one Android Studio ships, or
// Homebrew's openjdk@21 (keg-only, so macOS's java_home does not find it).
function findJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const brewJdk = (prefix) => path.join(prefix, 'opt', 'openjdk@21', 'libexec', 'openjdk.jdk', 'Contents', 'Home');
  const candidates = isWin
    ? ['C:\\Program Files\\Android\\Android Studio\\jbr']
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', brewJdk('/opt/homebrew'), brewJdk('/usr/local'), '/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr')];
  return candidates.find((p) => fs.existsSync(p));
}

function findSdk() {
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  const p = isWin ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : path.join(os.homedir(), 'Library', 'Android', 'sdk');
  return fs.existsSync(p) ? p : null;
}

// The certificate published watchBoard releases are signed with (1.0.3 onwards).
const RELEASE_CERT_SHA256 = 'e24a5e6229b5ae6b82ad11f34654a3e16f93c0ed1d9c5d881b25a667d2c7f0bc';

// The release keystore and its password: WATCHBOARD_KEYSTORE and WATCHBOARD_KEYSTORE_PASSWORD,
// or ~/.watchboard/release.keystore with its password in the macOS Keychain.
function releaseSigning() {
  const store = process.env.WATCHBOARD_KEYSTORE || path.join(os.homedir(), '.watchboard', 'release.keystore');
  if (!fs.existsSync(store)) {
    if (!process.env.WATCHBOARD_KEYSTORE) return null;
    console.error(`WATCHBOARD_KEYSTORE is set to ${store}, which does not exist.`);
    process.exit(1);
  }
  let password = process.env.WATCHBOARD_KEYSTORE_PASSWORD;
  if (!password && process.platform === 'darwin') {
    const res = spawnSync('security', ['find-generic-password', '-s', 'watchboard-release-keystore', '-w'], { encoding: 'utf8' });
    if (res.status === 0) password = res.stdout.trim();
  }
  if (!password) {
    console.error(`Found ${store} but not its password. Set WATCHBOARD_KEYSTORE_PASSWORD, or on a Mac add it to the Keychain as watchboard-release-keystore.`);
    process.exit(1);
  }
  return { WATCHBOARD_KEYSTORE: store, WATCHBOARD_KEYSTORE_PASSWORD: password };
}

function signerSha256(apk, env) {
  const tools = sdk && path.join(sdk, 'build-tools');
  if (!tools || !fs.existsSync(tools)) return null;
  const latest = fs.readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  const apksigner = path.join(tools, latest, isWin ? 'apksigner.bat' : 'apksigner');
  const res = spawnSync(apksigner, ['verify', '--print-certs', apk], { encoding: 'utf8', env, shell: isWin });
  return /certificate SHA-256 digest: ([0-9a-f]+)/.exec(res.stdout || '')?.[1] || null;
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
if (javaHome) {
  env.JAVA_HOME = javaHome;
  env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH || ''}`;
}
if (sdk) env.ANDROID_HOME = sdk;
if (release) {
  const signing = releaseSigning();
  if (signing) Object.assign(env, signing);
  else console.warn('\nNo release keystore found, so this release build is signed with your debug key.');
}
const androidDir = path.join(ROOT, 'android');
const gradlew = path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');
const variant = release ? 'release' : 'debug';
run(isWin ? `"${gradlew}"` : gradlew, [release ? 'assembleRelease' : 'assembleDebug', '--console=plain'], { cwd: androidDir, env });

const apk = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', release ? 'watchBoard.apk' : 'watchBoard-debug.apk');
fs.copyFileSync(apk, out);
console.log(`\nAPK ready: ${out}`);
if (release) {
  const cert = signerSha256(out, env);
  if (cert === RELEASE_CERT_SHA256) console.log('Signed with the watchBoard release key.');
  else console.warn(`\nWARNING: not signed with the watchBoard release key${cert ? ` (certificate ${cert})` : ''}, so it can't update installs of the published app.`);
}

if (install) {
  const adb = sdk ? path.join(sdk, 'platform-tools', isWin ? 'adb.exe' : 'adb') : 'adb';
  run(adb, ['install', '-r', out], { shell: false });
  run(adb, ['shell', 'am', 'start', '-n', 'dev.watchboard.app/.MainActivity'], { shell: false });
}
