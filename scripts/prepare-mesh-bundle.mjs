import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const version = '0.78.1';
const licenseUrl = `https://raw.githubusercontent.com/Mesh-LLM/mesh-llm/v${version}/LICENSE`;
const licenseSha256 = '44459b86c2e96fdbfd8a6b5c33d30d4b04b5293fcb2ec96fe4dcc4e0f90b8962';
const targets = {
  'darwin-arm64': {
    asset: 'mesh-llm-aarch64-apple-darwin.tar.gz',
    archiveSha256: 'fd67c8f450b0f7877e2edea3f5fd8d116ac225742fad6dc57037b04323b73579',
    binary: 'mesh-llm',
    runtime: 'meshllm-native-runtime-darwin-aarch64-metal',
    format: 'tar.gz',
    binarySha256: '48f7af521cc96fcdebe172d98c5fb03bda94d8872fe362d9b078106cfbd3178c'
  },
  'linux-x64': {
    asset: 'mesh-llm-x86_64-unknown-linux-gnu.tar.gz',
    archiveSha256: '8f50cb723781d189d0413443ec1904d7059f7cb895004823a1bc3cc10377d440',
    binary: 'mesh-llm',
    runtime: 'meshllm-native-runtime-linux-x86_64-cpu',
    format: 'tar.gz'
  },
  'win32-x64': {
    asset: 'mesh-llm-x86_64-pc-windows-msvc.zip',
    archiveSha256: 'b3bd5c47c066d474a65e8b2881d50aa182fdf4fe6d0729f039ced8ae7d253a30',
    binary: 'mesh-llm.exe',
    runtime: 'meshllm-native-runtime-windows-x86_64-cpu',
    format: 'zip'
  }
};

const hostTarget = process.platform === 'darwin' && process.arch === 'arm64' ? 'darwin-arm64'
  : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64'
    : process.platform === 'win32' && process.arch === 'x64' ? 'win32-x64'
      : undefined;
const targetName = process.env.OPENINFERENCE_MESH_TARGET?.trim() || hostTarget;
const target = targetName ? targets[targetName] : undefined;
if (!target || !targetName) {
  throw new Error(`Unsupported MeshLLM packaging target '${targetName ?? `${process.platform}-${process.arch}`}'; choose darwin-arm64, linux-x64, or win32-x64.`);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(repositoryRoot, '.data', `package-meshllm-v${version}`);
const bundleDirectory = join(cacheRoot, 'mesh-bundle');
const metadataPath = join(cacheRoot, 'bundle-source.json');
const archiveUrl = `https://github.com/Mesh-LLM/mesh-llm/releases/download/v${version}/${target.asset}`;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function bundleIsReady() {
  try {
    const source = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const binaryPath = join(bundleDirectory, target.binary);
    const runtimeManifest = join(bundleDirectory, 'native-runtimes', target.runtime, 'manifest.json');
    const licensePath = join(bundleDirectory, 'MESHLLM-LICENSE.txt');
    return source.version === version && source.target === targetName && source.archiveSha256 === target.archiveSha256 &&
      existsSync(binaryPath) && (!target.binarySha256 || sha256(binaryPath) === target.binarySha256) &&
      existsSync(runtimeManifest) && existsSync(join(bundleDirectory, 'host-imports.json')) &&
      existsSync(licensePath) && sha256(licensePath) === licenseSha256;
  } catch {
    return false;
  }
}

if (bundleIsReady()) {
  process.stdout.write(`MeshLLM ${version} is already prepared for ${targetName}.\n`);
  process.exit(0);
}

mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
const archivePath = join(tmpdir(), `open-inference-meshllm-v${version}-${targetName}.${target.format === 'zip' ? 'zip' : 'tar.gz'}`);
const stagingRoot = join(cacheRoot, `staging-${process.pid}`);
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });

process.stdout.write(`Downloading the official MeshLLM ${version} ${targetName} bundle…\n`);
const response = await fetch(archiveUrl, { redirect: 'follow' });
if (!response.ok || !response.body) throw new Error(`Could not download MeshLLM ${version} (HTTP ${response.status}).`);
await pipeline(response.body, createWriteStream(archivePath));
if (sha256(archivePath) !== target.archiveSha256) throw new Error('The MeshLLM download checksum did not match the pinned release checksum.');

const extractArgs = target.format === 'zip'
  ? ['-xf', archivePath, '-C', stagingRoot]
  : ['-xzf', archivePath, '-C', stagingRoot];
execFileSync('tar', extractArgs, { stdio: 'inherit' });
const stagedBundle = join(stagingRoot, 'mesh-bundle');
const stagedBinary = join(stagedBundle, target.binary);
const stagedRuntime = join(stagedBundle, 'native-runtimes', target.runtime, 'manifest.json');
if (!existsSync(stagedBinary) || !existsSync(stagedRuntime) || !existsSync(join(stagedBundle, 'host-imports.json')) ||
  (target.binarySha256 && sha256(stagedBinary) !== target.binarySha256)) {
  throw new Error(`The MeshLLM release is missing the expected ${targetName} host executable or bundled native runtime.`);
}

const licenseResponse = await fetch(licenseUrl, { redirect: 'follow' });
if (!licenseResponse.ok || !licenseResponse.body) throw new Error(`Could not download the MeshLLM license (HTTP ${licenseResponse.status}).`);
const stagedLicense = join(stagedBundle, 'MESHLLM-LICENSE.txt');
await pipeline(licenseResponse.body, createWriteStream(stagedLicense));
if (sha256(stagedLicense) !== licenseSha256) throw new Error('The MeshLLM license checksum did not match the pinned release.');

const archiveSize = statSync(archivePath).size;
rmSync(bundleDirectory, { recursive: true, force: true });
rmSync(metadataPath, { force: true });
renameSync(stagedBundle, bundleDirectory);
writeFileSync(metadataPath, JSON.stringify({ version, target: targetName, archiveUrl, archiveSha256: target.archiveSha256, ...(target.binarySha256 ? { binarySha256: target.binarySha256 } : {}) }, null, 2) + '\n', { mode: 0o600 });
rmSync(stagingRoot, { recursive: true, force: true });
rmSync(archivePath, { force: true });
process.stdout.write(`Prepared MeshLLM ${version} for ${targetName}; bundled CPU runtime is included and a matching GPU runtime is selected automatically when available (${Math.round(archiveSize / 1024 / 1024)} MB compressed).\n`);
