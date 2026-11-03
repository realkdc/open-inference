import assert from 'node:assert/strict';
import test from 'node:test';
import { meshOwnerIdFromKeypairHex } from '../dist/mesh-identity.js';

test('derives the MeshLLM owner ID from only the signing half of the SDK keypair', () => {
  assert.equal(
    meshOwnerIdFromKeypairHex('0'.repeat(128)),
    '139e3940e64b5491722088d9a0d741628fc826e09475d341a780acde3c4b8070'
  );
});

test('rejects malformed SDK keypairs before deriving a public identity', () => {
  assert.throws(() => meshOwnerIdFromKeypairHex('secret'), /exactly 64 bytes/);
});
