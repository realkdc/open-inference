import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const targets = {
  mac: { mesh: 'darwin-arm64', flags: ['--mac', '--arm64'], artifact: 'Open-Inference-Host-0.1.6-arm64-mac.zip' },
  windows: { mesh: 'win32-x64', flags: ['--win', '--x64'], artifact: 'Open-Inference-Host-0.1.6-x64-win.zip' },
  linux: { mesh: 'linux-x64', flags: ['--linux', '--x64'], artifact: 'Open-Inference-Host-0.1.6-x64-linux.tar.gz' }
};

const requested = process.argv[2] ?? 'mac';
const target = targets[requested];
if (!target) throw new Error(`Choose one target: ${Object.keys(targets).join(', ')}.`);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script through npm so it can find the project toolchain.');
const projectData = join(process.cwd(), '.data');
const electronCache = join(projectData, 'electron-cache');
const electronBuilderCache = join(projectData, 'electron-builder-cache');
mkdirSync(electronCache, { recursive: true });
mkdirSync(electronBuilderCache, { recursive: true });

function npm(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      ELECTRON_CACHE: electronCache,
      electron_config_cache: electronCache,
      ELECTRON_BUILDER_CACHE: electronBuilderCache
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

npm(['run', 'build:contributor']);
npm(['run', 'prepare:mesh-bundle'], { OPENINFERENCE_MESH_TARGET: target.mesh });
npm(['run', 'package:electron-builder', '--', '--config', 'apps/contributor/electron-builder.yml', ...target.flags, '--publish', 'never']);

const artifactPath = resolve('release', target.artifact);
if (!existsSync(artifactPath)) throw new Error(`The packager finished but did not create the expected download: ${artifactPath}`);
process.stdout.write(`Contributor download is ready: ${artifactPath}\n`);
