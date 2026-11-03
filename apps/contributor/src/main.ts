import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, totalmem } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMeshServeArgs, meshOwnerIdFromStatus, MINIMUM_MESH_VERSION, meshVersionAtLeast, splitCoordinatorForRole } from './mesh-command.js';
import { approvedOwnerIdsForHost } from './admission.js';
import { modelReadiness } from './model-readiness.js';
import { recommendModelMemoryGb, type ResourceBudget } from './resource-budget.js';
import { contributorModelById, contributorModelByRef, DEFAULT_CONTRIBUTOR_MODEL_ID } from './models.js';

type HostStatus = {
  state: 'offline' | 'checking' | 'starting' | 'connected' | 'contributing' | 'paused' | 'error';
  message: string;
  model?: string;
};

type PresenceConfig = { serviceUrl: string; hostToken: string; region: string };

const API_PORT = 19_337;
const MANAGEMENT_PORT = 19_338;
const DEFAULT_CONTEXT_TOKENS = 2048;
const MESH_BUNDLE_DIRECTORY = 'meshllm';
let windowRef: BrowserWindow | undefined;
let meshProcess: ChildProcess | undefined;
let joinFilePath: string | undefined;
let healthTimer: ReturnType<typeof setTimeout> | undefined;
let status: HostStatus = { state: 'offline', message: 'Not contributing compute.' };
let stopping = false;
let quitting = false;
let isPaused = false;
let savedJoinToken: string | undefined;
let savedModel: string | undefined;
let savedServiceUrl: string | undefined;
let savedMaxVramGb: number | undefined;
let savedContextTokens = DEFAULT_CONTEXT_TOKENS;
let savedSplitCoordinator = false;
let savedPresence: PresenceConfig | undefined;
let lastPresenceSentAt = 0;
let presenceTask: Promise<void> | undefined;

function publish(next: HostStatus): HostStatus {
  status = next;
  windowRef?.webContents.send('host:status', status);
  return status;
}

function appDataDir(): string {
  const directory = app.getPath('userData');
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) {
    try { chmodSync(directory, 0o700); } catch { /* Windows applies directory ACLs instead. */ }
  }
  return directory;
}

function bundledMeshDirectory(): string {
  return join(process.resourcesPath, MESH_BUNDLE_DIRECTORY);
}

function cliPath(): string {
  const configured = app.isPackaged ? undefined : process.env.OPENINFERENCE_MESH_CLI?.trim();
  if (configured) return configured;

  const bundledName = process.platform === 'win32' ? 'mesh-llm.exe' : 'mesh-llm';
  const bundledPath = join(bundledMeshDirectory(), bundledName);
  if (existsSync(bundledPath)) return bundledPath;
  if (app.isPackaged) return bundledPath;

  const localAppData = process.env.LOCALAPPDATA;
  const candidates = process.platform === 'win32'
    ? [...(localAppData ? [join(localAppData, 'mesh-llm', 'bin', 'mesh-llm.exe')] : []), 'mesh-llm.exe', 'mesh-llm']
    : [join(homedir(), '.local', 'bin', 'mesh-llm'), 'mesh-llm'];
  return candidates.find(candidate => candidate.includes('/') || candidate.includes('\\')
    ? existsSync(candidate)
    : process.env.PATH?.split(delimiter).some(directory => existsSync(join(directory, candidate)))) ?? 'mesh-llm';
}

function privateConfigPath(): string {
  const path = join(appDataDir(), 'mesh-llm-config.toml');
  const config = [
    'version = 1',
    '',
    '[telemetry]',
    'enabled = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[logging]',
    'enabled = true',
    '',
    '[logging.artifact]',
    'capture_mode = "metadata_only"',
    '',
    '[runtime]',
    'mode = "serve"',
    'startup_failure_policy = "fail_fast"',
    '',
    '[runtime.native_runtime]',
    'download = true',
    ''
  ].join('\n');
  writeFileSync(path, config, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows applies file ACLs instead. */ }
  return path;
}

function meshOwnerKeyPath(): string {
  return join(appDataDir(), 'mesh-owner-keystore.json');
}

function meshEnvironment(configPath: string): NodeJS.ProcessEnv {
  const dataDirectory = join(appDataDir(), 'mesh-data');
  const modelCacheDirectory = join(appDataDir(), 'model-cache');
  const hubCache = join(modelCacheDirectory, 'huggingface-hub');
  const xetCache = join(modelCacheDirectory, 'huggingface-xet');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(hubCache, { recursive: true, mode: 0o700 });
  mkdirSync(xetCache, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    MESH_LLM_CONFIG: configPath,
    MESH_LLM_DATA_DIR: dataDirectory,
    HF_HUB_CACHE: hubCache,
    HF_XET_CACHE: xetCache
  };
  const runtimeBundle = join(bundledMeshDirectory(), 'native-runtimes');
  if (existsSync(runtimeBundle) || app.isPackaged) environment.MESH_LLM_NATIVE_RUNTIME_BUNDLE_DIR = runtimeBundle;
  const allowed = [
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'TERM', 'HUGGINGFACE_HUB_CACHE',
    'CUDA_PATH', 'ROCM_PATH', 'HIP_PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
    'CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'GGML_VK_VISIBLE_DEVICES'
  ];
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function writeJoinFile(token: string): string {
  const path = join(appDataDir(), 'mesh-join-token');
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  try { chmodSync(path, 0o600); } catch { /* Windows applies file ACLs instead. */ }
  joinFilePath = path;
  return path;
}

function runCli(args: string[], timeoutMs = 30_000, outputStream: 'stdout' | 'stderr' = 'stdout'): Promise<string> {
  return new Promise((resolve, reject) => {
    const configPath = privateConfigPath();
    const child = spawn(cliPath(), [...args, '--config', configPath], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', outputStream === 'stdout' ? 'pipe' : 'ignore', outputStream === 'stderr' ? 'pipe' : 'ignore'],
      env: meshEnvironment(configPath)
    });
    let output = '';
    let settled = false;
    const finish = (error?: Error, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('MeshLLM did not respond in time.'));
    }, timeoutMs);
    const capturedStream = outputStream === 'stdout' ? child.stdout : child.stderr;
    capturedStream?.on('data', chunk => {
      output += String(chunk);
      if (output.length > 2_000_000) {
        child.kill('SIGKILL');
        finish(new Error('MeshLLM returned too much catalog data.'));
      }
    });
    child.once('error', () => finish(new Error(app.isPackaged
      ? 'The bundled MeshLLM runtime could not start. Reinstall the Open Inference Host app.'
      : 'MeshLLM could not start. Build the bundled runtime or install the official MeshLLM CLI for development.')));
    child.once('close', code => {
      if (code !== 0) {
        finish(new Error('MeshLLM could not complete that action. Check its installation and model reference.'));
        return;
      }
      finish(undefined, output);
    });
  });
}

async function ensureMeshOwnerIdentity(): Promise<{ ownerKey: string; ownerId: string }> {
  const version = await runCli(['--version'], 10_000);
  if (!meshVersionAtLeast(version.trim())) {
    throw new Error(`Update the official MeshLLM command-line runtime to version ${MINIMUM_MESH_VERSION.join('.')} or later before sharing.`);
  }

  const ownerKey = meshOwnerKeyPath();
  if (!existsSync(ownerKey)) {
    try {
      await runCli(['auth', 'init', '--owner-key', ownerKey, '--no-passphrase']);
    } catch {
      if (!existsSync(ownerKey)) throw new Error('MeshLLM could not create this computer’s private owner identity.');
    }
  }
  try {
    const info = lstatSync(ownerKey);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The MeshLLM owner identity must be a regular private file.');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error('The MeshLLM owner identity file is readable by other local users. Fix its permissions before sharing.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The MeshLLM owner identity')) throw error;
    throw new Error('MeshLLM could not read this computer’s private owner identity.');
  }
  try {
    const status = await runCli(['auth', 'status', '--owner-key', ownerKey], 10_000, 'stderr');
    const ownerId = meshOwnerIdFromStatus(status);
    if (!ownerId) throw new Error('The owner identity is missing from MeshLLM status.');
    return { ownerKey, ownerId };
  } catch {
    throw new Error('MeshLLM could not verify this computer’s owner identity. Update the runtime or repair its local owner key.');
  }
}

async function resourceBudget(): Promise<ResourceBudget> {
  let gpus: Array<{ unifiedMemory?: boolean; allocatableVramBytes?: number; vramBytes?: number; ratedVramGb?: number }> = [];
  try {
    const output = await runCli(['gpus', '--json'], 15_000);
    const parsed = JSON.parse(output) as { gpus?: unknown };
    if (Array.isArray(parsed.gpus)) {
      gpus = parsed.gpus.flatMap(item => {
        if (typeof item !== 'object' || item === null) return [];
        const row = item as Record<string, unknown>;
        return [{
          unifiedMemory: row.unified_memory === true,
          allocatableVramBytes: typeof row.allocatable_vram_bytes === 'number' ? row.allocatable_vram_bytes : undefined,
          vramBytes: typeof row.vram_bytes === 'number' ? row.vram_bytes : undefined,
          ratedVramGb: typeof row.rated_vram_gb === 'number' ? row.rated_vram_gb : undefined
        }];
      });
    }
  } catch {
    // The RAM-only estimate is still safe when GPU inventory is unavailable.
  }
  return recommendModelMemoryGb({ totalMemoryBytes: totalmem(), gpus });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is already in use. Close the other MeshLLM process and try again.`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

function stopProcess(signal: NodeJS.Signals): Promise<void> {
  const child = meshProcess;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });
}

function clearHealthTimer(): void {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = undefined;
}

async function pollWorkerStatus(child: ChildProcess, model: string): Promise<void> {
  if (meshProcess !== child || stopping || isPaused) return;
  try {
    const response = await fetch(`http://127.0.0.1:${MANAGEMENT_PORT}/health`, { signal: AbortSignal.timeout(1_500) });
    const result: unknown = response.ok ? await response.json() : null;
    if (typeof result === 'object' && result !== null && 'mesh' in result && ('serving' in result || 'worker' in result || 'mode' in result)) {
      const health = result as {
        mode?: string;
        mesh?: { status?: string };
        serving?: { status?: string; models?: string[] };
        worker?: { status?: string; models?: string[] };
        models?: string[];
      };
      const modelDetails = contributorModelByRef(model);
      const readiness = modelReadiness(health, modelDetails ? [model, modelDetails.apiModelId] : model);
      if (readiness.ready) {
        const message = readiness.splitStage
          ? 'MeshLLM assigned this computer a ready split-model stage.'
          : 'The selected model is ready on this computer. Full pool readiness still needs a successful split-model request.';
        publish({ state: 'contributing', message, model });
        if (Date.now() - lastPresenceSentAt > 45_000) void reportPresence('online');
      } else if (health.mesh?.status === 'connected' || health.mesh?.status === 'standalone') {
        if (status.state === 'contributing') void reportPresence('offline');
        publish({ state: 'connected', message: 'Connected to MeshLLM. Waiting for the model stage to become ready.', model });
      } else if (health.mesh?.status === 'disconnected') {
        if (status.state === 'contributing') void reportPresence('offline');
        publish({ state: 'starting', message: 'MeshLLM is running and trying to reconnect to the shared pool.', model });
      }
    }
  } catch {
    // Startup can take a while while MeshLLM downloads its runtime or model package.
  }
  if (meshProcess === child && !stopping && !isPaused) {
    healthTimer = setTimeout(() => void pollWorkerStatus(child, model), 2_000);
  }
}

function cleanupJoinFile(): void {
  if (!joinFilePath) return;
  try { rmSync(joinFilePath, { force: true }); } catch { /* Best-effort cleanup after process exit. */ }
  joinFilePath = undefined;
}

async function launchWorker(model: string, token: string, serviceUrl: string, maxVramGb: number | undefined, contextTokens: number, splitCoordinator: boolean, presenceConfig?: PresenceConfig): Promise<HostStatus> {
  if (meshProcess && meshProcess.exitCode === null) throw new Error('This computer is already connected. Pause it before changing models.');
  const identity = await ensureMeshOwnerIdentity();
  const trustedOwnerIds = await approvedMeshOwners(serviceUrl, identity.ownerId);
  await assertPortAvailable(API_PORT);
  await assertPortAvailable(MANAGEMENT_PORT);

  stopping = false;
  isPaused = false;
  const configPath = privateConfigPath();
  const tokenPath = writeJoinFile(token);
  const args = buildMeshServeArgs({
    model,
    joinFile: tokenPath,
    ownerKey: identity.ownerKey,
    configPath,
    apiPort: API_PORT,
    managementPort: MANAGEMENT_PORT,
    contextTokens,
    maxVramGb,
    trustedOwnerIds,
    splitCoordinator
  });

  savedJoinToken = token;
  savedModel = model;
  savedServiceUrl = serviceUrl;
  savedMaxVramGb = maxVramGb;
  savedContextTokens = contextTokens;
  savedSplitCoordinator = splitCoordinator;
  savedPresence = presenceConfig;
  lastPresenceSentAt = 0;
  publish({
    state: 'starting',
    message: splitCoordinator
      ? 'Starting the model coordinator. MeshLLM prepares a compatible runtime and downloads model files automatically.'
      : 'Joining as a model worker. MeshLLM prepares a compatible runtime and downloads model files automatically.',
    model
  });
  const child = spawn(cliPath(), args, {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
    env: meshEnvironment(configPath)
  });
  meshProcess = child;
  child.once('error', () => {
    if (meshProcess !== child || stopping) return;
    meshProcess = undefined;
    clearHealthTimer();
    cleanupJoinFile();
    void reportPresence('offline');
    publish({ state: 'error', message: 'MeshLLM could not start. Reinstall the Open Inference Host app and try again.' });
  });
  child.once('spawn', () => {
    if (meshProcess === child && !stopping) {
      void pollWorkerStatus(child, model);
    }
  });
  child.once('exit', () => {
    const wasStopping = stopping;
    if (meshProcess === child) meshProcess = undefined;
    clearHealthTimer();
    cleanupJoinFile();
    void reportPresence('offline');
    if (wasStopping) return;
    publish({ state: 'error', message: 'The worker stopped. Check the MeshLLM installation, model support, and network.' });
  });
  return status;
}

async function startSharing(input: unknown): Promise<HostStatus> {
  if (typeof input !== 'object' || input === null) throw new Error('Enter the mesh invite.');
  const value = input as {
    inviteToken?: unknown; serviceUrl?: unknown; modelId?: unknown; poolRole?: unknown; acknowledged?: unknown; inviteAcknowledged?: unknown;
    presence?: { optIn?: unknown; serviceUrl?: unknown; hostToken?: unknown; region?: unknown };
  };
  if (typeof value.inviteToken !== 'string' || value.inviteToken.trim().length < 16 || value.inviteToken.length > 4096 || /[\r\n]/.test(value.inviteToken)) {
    throw new Error('Enter a valid community mesh join token.');
  }
  if (value.acknowledged !== true || value.inviteAcknowledged !== true) {
    throw new Error('Confirm the shared-compute and shared-invite disclosures before joining.');
  }
  const serviceUrl = parseServiceUrl(value.serviceUrl);
  const model = contributorModelById(value.modelId ?? DEFAULT_CONTRIBUTOR_MODEL_ID);
  if (!model) throw new Error('Choose one of the supported beta models.');
  const splitCoordinator = splitCoordinatorForRole(value.poolRole);
  const contextTokens = DEFAULT_CONTEXT_TOKENS;
  const budget = await resourceBudget();
  if (budget.recommendedModelMemoryGb < 0.5) {
    throw new Error('This computer has less than 0.5 GB available under the beta safety limit and cannot contribute a model stage.');
  }
  return launchWorker(model.modelRef, value.inviteToken.trim(), serviceUrl, budget.recommendedModelMemoryGb, contextTokens, splitCoordinator, parsePresence(value.presence));
}

function parsePresence(value: { optIn?: unknown; serviceUrl?: unknown; hostToken?: unknown; region?: unknown } | undefined): PresenceConfig | undefined {
  if (value?.optIn !== true) return undefined;
  if (typeof value.serviceUrl !== 'string' || typeof value.hostToken !== 'string' || typeof value.region !== 'string') {
    throw new Error('Enter the Open Inference server, host token, and broad region to opt in to the map.');
  }
  let url: URL;
  try { url = new URL(value.serviceUrl.trim()); }
  catch { throw new Error('Enter a valid Open Inference server address.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use HTTPS for the server, or HTTP on this computer for local testing.');
  }
  if (!/^oi_host_[A-Za-z0-9_-]{40,60}$/.test(value.hostToken)) throw new Error('The map host token does not look valid.');
  const regions = ['na-west', 'na-central', 'na-east', 'south-america', 'europe-west', 'europe-central', 'europe-east', 'africa', 'middle-east', 'south-asia', 'east-asia', 'southeast-asia', 'oceania'];
  if (!regions.includes(value.region)) throw new Error('Choose one broad region from the list.');
  return { serviceUrl: url.toString().replace(/\/+$/, ''), hostToken: value.hostToken, region: value.region };
}

function parseServiceUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter the Open Inference beta server address.');
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error('Enter a valid Open Inference beta server address.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use the HTTPS beta server address, or HTTP on this computer for local testing.');
  }
  return url.origin;
}

async function approvedMeshOwners(serviceUrl: string, localOwnerId: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/api/community/admission`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    throw new Error('Could not reach the Open Inference beta server to check this computer’s admission.');
  }
  if (!response.ok) throw new Error('The Open Inference beta server could not check this computer’s admission.');
  const value: unknown = await response.json();
  return approvedOwnerIdsForHost(value, localOwnerId);
}

async function reportPresence(state: 'online' | 'offline'): Promise<void> {
  const current = savedPresence;
  if (!current) return;
  if (presenceTask) {
    await presenceTask;
    if (state === 'online' || current !== savedPresence) return;
  }
  lastPresenceSentAt = Date.now();
  const task = (async () => {
    try {
    await fetch(`${current.serviceUrl}/api/community/presence`, {
      method: 'POST',
      headers: { authorization: `Bearer ${current.hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ region: current.region, state }),
      redirect: 'error',
      signal: AbortSignal.timeout(2_500)
    });
    } catch {
      // Map reporting is optional and never affects inference serving.
    }
  })();
  presenceTask = task;
  try { await task; }
  finally { if (presenceTask === task) presenceTask = undefined; }
}

async function pauseSharing(): Promise<HostStatus> {
  if (!meshProcess || meshProcess.exitCode !== null) {
    return publish({ state: 'offline', message: 'This computer is not connected.' });
  }
  await reportPresence('offline');
  stopping = true;
  isPaused = true;
  clearHealthTimer();
  publish({ state: 'starting', message: 'Pausing the worker and disconnecting it from the shared pool.', model: savedModel });
  await stopProcess('SIGTERM');
  meshProcess = undefined;
  stopping = false;
  isPaused = false;
  cleanupJoinFile();
  return publish({ state: 'paused', message: 'Sharing paused. This computer is disconnected from the pool.', model: savedModel });
}

async function resumeSharing(): Promise<HostStatus> {
  if (!savedJoinToken || !savedModel || !savedServiceUrl) throw new Error('Enter the beta server address, mesh join token, and model again to resume.');
  const budget = await resourceBudget();
  if (budget.recommendedModelMemoryGb < 0.5) {
    throw new Error('This computer has less than 0.5 GB available under the beta safety limit and cannot contribute this model.');
  }
  savedMaxVramGb = budget.recommendedModelMemoryGb;
  return launchWorker(savedModel, savedJoinToken, savedServiceUrl, savedMaxVramGb, savedContextTokens, savedSplitCoordinator, savedPresence);
}

async function disconnectSharing(): Promise<HostStatus> {
  if (meshProcess && meshProcess.exitCode === null) await pauseSharing();
  isPaused = false;
  savedJoinToken = undefined;
  savedModel = undefined;
  savedServiceUrl = undefined;
  savedMaxVramGb = undefined;
  savedContextTokens = DEFAULT_CONTEXT_TOKENS;
  savedSplitCoordinator = false;
  savedPresence = undefined;
  return publish({ state: 'offline', message: 'Disconnected. The mesh token was cleared from memory.' });
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 760,
    height: 850,
    minWidth: 620,
    minHeight: 700,
    title: 'Open Inference Contributor',
    backgroundColor: '#080b13',
    webPreferences: {
      preload: join(fileURLToPath(new URL('.', import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const rendererPath = app.isPackaged
    ? join(app.getAppPath(), 'renderer', 'index.html')
    : join(fileURLToPath(new URL('.', import.meta.url)), '..', 'renderer', 'index.html');
  const rendererUrl = pathToFileURL(rendererPath).toString();
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedDocsUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  windowRef.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) {
      event.preventDefault();
      if (isAllowedDocsUrl(url)) void shell.openExternal(url);
    }
  });
  void windowRef.loadFile(rendererPath);
  windowRef.on('closed', () => { windowRef = undefined; });
}

function isAllowedDocsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'meshllm.cloud';
  } catch {
    return false;
  }
}

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(() => {
    appDataDir();
    privateConfigPath();
    const staleJoinFile = join(appDataDir(), 'mesh-join-token');
    try { rmSync(staleJoinFile, { force: true }); } catch { /* Remove stale bootstrap material after a previous crash. */ }
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  ipcMain.handle('host:status', () => status);
  ipcMain.handle('host:resource-budget', () => resourceBudget());
  ipcMain.handle('host:owner-id', async () => (await ensureMeshOwnerIdentity()).ownerId);
  ipcMain.handle('host:start-sharing', async (_event, input: unknown) => startSharing(input));
  ipcMain.handle('host:pause', () => pauseSharing());
  ipcMain.handle('host:resume', () => resumeSharing());
  ipcMain.handle('host:disconnect', () => disconnectSharing());

  app.on('before-quit', event => {
    if (!meshProcess || meshProcess.exitCode !== null) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    stopping = true;
    clearHealthTimer();
    void reportPresence('offline').finally(() => stopProcess('SIGTERM')).finally(() => {
      meshProcess = undefined;
      cleanupJoinFile();
      stopping = false;
      app.quit();
    });
  });
} else {
  app.quit();
}
