export type MeshServeOptions = {
  model: string;
  joinFile: string;
  ownerKey: string;
  configPath: string;
  apiPort: number;
  managementPort: number;
  contextTokens: number;
  maxVramGb?: number;
  trustedOwnerIds: string[];
  splitCoordinator: boolean;
};

export const MINIMUM_MESH_VERSION = [0, 78, 1] as const;

export function meshVersionAtLeast(version: string, minimum = MINIMUM_MESH_VERSION): boolean {
  const match = version.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function meshOwnerIdFromStatus(statusText: string): string | undefined {
  const match = /(?:^|\n)Owner ID:\s*([a-f0-9]{64})(?:\s|$)/i.exec(statusText);
  return match?.[1]?.toLowerCase();
}

export function splitCoordinatorForRole(role: unknown): boolean {
  if (role === 'coordinator') return true;
  if (role === 'worker') return false;
  throw new Error('Choose whether this is the first computer for the model or is joining an existing pool.');
}

export function buildMeshServeArgs(options: MeshServeOptions): string[] {
  const trustedOwnerIds = [...new Set(options.trustedOwnerIds.map(id => id.toLowerCase()))];
  if (trustedOwnerIds.length === 0 || trustedOwnerIds.some(id => !/^[a-f0-9]{64}$/.test(id))) {
    throw new Error('An approved MeshLLM owner allowlist is required before this computer can join.');
  }
  const args = [
    'serve', '--model', options.model, '--join-file', options.joinFile, '--headless',
    '--port', String(options.apiPort), '--console', String(options.managementPort),
    '--name', 'open-inference-contributor', '--config', options.configPath,
    '--ctx-size', String(options.contextTokens),
    '--owner-key', options.ownerKey, '--owner-required', '--trust-policy', 'allowlist'
  ];
  for (const ownerId of trustedOwnerIds) args.push('--trust-owner', ownerId);
  if (options.splitCoordinator) args.push('--split', '--auto-balance');
  if (options.maxVramGb !== undefined) args.push('--max-vram', String(options.maxVramGb));
  return args;
}
