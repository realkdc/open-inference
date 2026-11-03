import assert from 'node:assert/strict';
import test from 'node:test';
import { PresenceRegistry } from '../dist/presence.js';

test('the public map hides a region until three hosts report it', () => {
  const presence = new PresenceRegistry();
  presence.heartbeat('host-a', 'na-central');
  presence.heartbeat('host-b', 'na-central');
  assert.deepEqual(presence.publicClusters(), []);

  presence.heartbeat('host-c', 'na-central');
  assert.deepEqual(presence.publicClusters(), [{ region: 'na-central', countBand: '3–5' }]);
});

test('the public map returns only a broad region and a count band', () => {
  const presence = new PresenceRegistry();
  for (const id of ['host-a', 'host-b', 'host-c', 'host-d', 'host-e', 'host-f']) {
    presence.heartbeat(id, 'europe-west');
  }
  const publicClusters = presence.publicClusters();
  assert.deepEqual(publicClusters, [{ region: 'europe-west', countBand: '6–10' }]);
  assert.equal(JSON.stringify(publicClusters).includes('host-'), false);
});

test('offline hosts disappear from the public map', () => {
  const presence = new PresenceRegistry();
  for (const id of ['host-a', 'host-b', 'host-c']) presence.heartbeat(id, 'oceania');
  assert.equal(presence.publicClusters().length, 1);
  presence.disconnect('host-c');
  assert.deepEqual(presence.publicClusters(), []);
});
