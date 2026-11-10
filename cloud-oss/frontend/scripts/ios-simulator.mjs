import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Builds the Capacitor app for the iOS simulator, then installs and launches it on a booted
// (or the first available iPhone) simulator. Set IOS_SIMULATOR=<name or UDID> to choose one.
const frontend = fileURLToPath(new URL('../', import.meta.url));
const project = path.join(frontend, 'ios', 'App');
const derivedData = path.join(project, 'build', 'DerivedData');
const appPath = path.join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
const config = JSON.parse(readFileSync(path.join(project, 'App', 'capacitor.config.json'), 'utf8'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: project, stdio: 'inherit', ...options });
  if (result.error) {
    console.error(`Unable to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

if (process.platform !== 'darwin') {
  console.error('iOS simulator builds require macOS with Xcode.');
  process.exit(1);
}

const listing = run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { stdio: 'pipe' });
const devices = Object.entries(JSON.parse(listing.stdout.toString()).devices)
  .filter(([runtime]) => runtime.includes('iOS'))
  .flatMap(([, list]) => list);
const wanted = process.env.IOS_SIMULATOR;
const device = wanted
  ? devices.find((item) => item.udid === wanted || item.name === wanted)
  : devices.find((item) => item.state === 'Booted') ?? devices.find((item) => item.name.startsWith('iPhone'));
if (!device) {
  console.error(wanted ? `Simulator not found: ${wanted}` : 'No available iPhone simulator found.');
  process.exit(1);
}

run('xcodebuild', [
  '-project', 'App.xcodeproj',
  '-scheme', 'App',
  '-configuration', 'Debug',
  '-sdk', 'iphonesimulator',
  '-destination', `id=${device.udid}`,
  '-derivedDataPath', derivedData,
  'CODE_SIGNING_ALLOWED=NO',
  'build',
]);

if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
// The Simulator GUI is optional: install and launch work against a headless booted device.
const gui = spawnSync('open', ['-b', 'com.apple.iphonesimulator', '--args', '-CurrentDeviceUDID', device.udid]);
if (gui.status !== 0) console.warn('Simulator.app not found; the device is running headless.');
run('xcrun', ['simctl', 'install', device.udid, appPath]);
run('xcrun', ['simctl', 'launch', device.udid, config.appId]);
console.log(`Launched ${config.appId} on ${device.name} (${device.udid}).`);
