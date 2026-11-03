import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendModelMemoryGb } from '../dist/resource-budget.js';

const gb = 1024 ** 3;

test('an eight GB Apple Silicon Mac gets a conservative automatic cap', () => {
  const budget = recommendModelMemoryGb({ totalMemoryBytes: 8 * gb, gpus: [{ unifiedMemory: true }] });
  assert.equal(budget.systemMemoryGb, 8);
  assert.equal(budget.recommendedModelMemoryGb, 1.5);
  assert.equal(budget.deviceMemoryLimited, false);
});

test('six GB or less cannot contribute while preserving system headroom', () => {
  const budget = recommendModelMemoryGb({ totalMemoryBytes: 6 * gb });
  assert.equal(budget.recommendedModelMemoryGb, 0);
});

test('dedicated GPU memory and host RAM both limit the recommendation', () => {
  const budget = recommendModelMemoryGb({
    totalMemoryBytes: 32 * gb,
    freeMemoryBytes: 24 * gb,
    gpus: [{ allocatableVramBytes: 6 * gb, vramBytes: 8 * gb }]
  });
  assert.equal(budget.recommendedModelMemoryGb, 3);
  assert.equal(budget.deviceMemoryLimited, true);
});
