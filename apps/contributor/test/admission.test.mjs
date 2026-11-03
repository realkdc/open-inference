import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedOwnerIdsForHost } from '../dist/admission.js';

test('an approved host can join while community inference remains paused', () => {
  const gateway = 'a'.repeat(64);
  const host = 'b'.repeat(64);
  const owners = approvedOwnerIdsForHost({
    admissionVerified: false,
    trustedOwnerIds: [gateway, host],
    gatewayOwnerId: gateway
  }, host);
  assert.deepEqual(owners, [gateway, host]);
});

test('an unapproved host receives its owner ID and cannot join', () => {
  const gateway = 'a'.repeat(64);
  const host = 'b'.repeat(64);
  assert.throws(() => approvedOwnerIdsForHost({
    admissionVerified: false,
    trustedOwnerIds: [gateway],
    gatewayOwnerId: gateway
  }, host), /This computer is not approved yet/);
});

test('malformed owner lists cannot be used to start a host', () => {
  assert.throws(() => approvedOwnerIdsForHost({
    trustedOwnerIds: ['not-an-owner-id'],
    gatewayOwnerId: 'a'.repeat(64)
  }, 'a'.repeat(64)), /owner allowlist/);
});
