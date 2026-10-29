import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
const androidTasks = {
  'android-debug': [':app:assembleDebug'],
  'android-release': [':app:assembleRelease', ':app:bundleRelease'],
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(`Unable to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (Object.hasOwn(androidTasks, target)) {
  const cwd = path.join(frontend, 'android');
  const args = ['--no-daemon', ...androidTasks[target]];
  if (process.platform === 'win32') {
    run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'gradlew.bat', ...args], cwd);
  } else {
    run('sh', ['./gradlew', ...args], cwd);
  }
} else if (target === 'ios-simulator' || target === 'ios-archive') {
  if (process.platform !== 'darwin') {
    console.error('iOS builds require macOS with Xcode 26 or later.');
    process.exit(1);
  }
  const cwd = path.join(frontend, 'ios', 'App');
  const args = [
    '-project', 'App.xcodeproj',
    '-scheme', 'App',
    '-derivedDataPath', path.join(cwd, 'build', 'DerivedData'),
    'CODE_SIGNING_ALLOWED=NO',
  ];
  if (target === 'ios-simulator') {
    args.push('-configuration', 'Debug', '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator', 'build');
  } else {
    args.push('-configuration', 'Release', '-sdk', 'iphoneos',
      '-destination', 'generic/platform=iOS',
      '-archivePath', path.join(cwd, 'build', 'OSS-Music.xcarchive'), 'archive');
  }
  run('xcodebuild', args, cwd);
} else {
  console.error('Choose android-debug, android-release, ios-simulator, or ios-archive.');
  process.exit(1);
}
