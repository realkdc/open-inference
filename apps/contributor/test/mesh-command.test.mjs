import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMeshServeArgs, meshOwnerIdFromStatus, meshVersionAtLeast, splitCoordinatorForRole } from '../dist/mesh-command.js';

const base = {
  model: 'unsloth/Qwen3-8B-GGUF:Q4_K_M',
  joinFile: '/private/app-data/mesh-join-token',
  ownerKey: '/private/app-data/mesh-owner-keystore.json',
  configPath: '/private/app-data/mesh.toml',
  apiPort: 19337,
  managementPort: 19338,
  contextTokens: 2048,
  trustedOwnerIds: ['a'.repeat(64), 'b'.repeat(64)]
};

test('the contributor requires a MeshLLM release with owner allowlist support', () => {
  assert.equal(meshVersionAtLeast('mesh-llm 0.78.1 (bc215ce)'), true);
  assert.equal(meshVersionAtLeast('mesh-llm v0.79.0'), true);
  assert.equal(meshVersionAtLeast('mesh-llm 0.78.0'), false);
  assert.equal(meshVersionAtLeast('mesh-llm 0.78.1-rc1'), false);
  assert.equal(meshVersionAtLeast('not a version'), false);
});

test('only the designated coordinator gets the force-split flag', () => {
  const coordinatorArgs = buildMeshServeArgs({ ...base, splitCoordinator: true });
  const workerArgs = buildMeshServeArgs({ ...base, splitCoordinator: false });

  assert.equal(coordinatorArgs.includes('--split'), true);
  assert.equal(coordinatorArgs.includes('--auto-balance'), true);
  assert.equal(workerArgs.includes('--split'), false);
  assert.equal(workerArgs.includes('--auto-balance'), false);
  assert.equal(coordinatorArgs.includes(base.joinFile), true);
  assert.equal(coordinatorArgs[coordinatorArgs.indexOf('--owner-key') + 1], base.ownerKey);
  assert.equal(coordinatorArgs.includes('--owner-required'), true);
  assert.equal(coordinatorArgs[coordinatorArgs.indexOf('--trust-policy') + 1], 'allowlist');
  assert.deepEqual(
    coordinatorArgs.flatMap((arg, index) => arg === '--trust-owner' ? [coordinatorArgs[index + 1]] : []),
    base.trustedOwnerIds
  );
  assert.equal(coordinatorArgs.includes('some-secret-token'), false);
});

test('a host must explicitly choose whether it starts a pool or joins one', () => {
  assert.equal(splitCoordinatorForRole('coordinator'), true);
  assert.equal(splitCoordinatorForRole('worker'), false);
  assert.throws(() => splitCoordinatorForRole(undefined), /first computer/);
  assert.throws(() => splitCoordinatorForRole('other'), /first computer/);
});

test('MeshLLM identity status parsing returns only the public owner ID', () => {
  assert.equal(meshOwnerIdFromStatus('Owner ID: ' + 'a'.repeat(64) + '\nSigning key: private'), 'a'.repeat(64));
  assert.equal(meshOwnerIdFromStatus('Owner ID: invalid'), undefined);
});

test('a node cannot start with an empty or malformed owner allowlist', () => {
  assert.throws(() => buildMeshServeArgs({ ...base, trustedOwnerIds: [] }), /allowlist is required/);
  assert.throws(() => buildMeshServeArgs({ ...base, trustedOwnerIds: ['not-an-owner'] }), /allowlist is required/);
});

test('memory cap and context limit are passed to MeshLLM', () => {
  const args = buildMeshServeArgs({ ...base, splitCoordinator: false, maxVramGb: 1.5 });
  assert.equal(args[args.indexOf('--ctx-size') + 1], '2048');
  assert.equal(args[args.indexOf('--max-vram') + 1], '1.5');
});
