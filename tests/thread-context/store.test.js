import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { SessionStore } from '../../thread-context/store.js';

describe('SessionStore', () => {
  let store;
  const sampleHistory = [{ role: 'user', parts: [{ text: 'hello' }] }];

  beforeEach(() => {
    store = new SessionStore();
  });

  it('stores and retrieves history', () => {
    store.setHistory('C1', 'T1', sampleHistory);
    assert.deepStrictEqual(store.getHistory('C1', 'T1'), sampleHistory);
  });

  it('returns null for missing key', () => {
    assert.strictEqual(store.getHistory('C1', 'T99'), null);
  });

  it('keeps different threads independent', () => {
    const h1 = [{ role: 'user', parts: [{ text: 'one' }] }];
    const h2 = [{ role: 'user', parts: [{ text: 'two' }] }];
    store.setHistory('C1', 'T1', h1);
    store.setHistory('C1', 'T2', h2);
    assert.deepStrictEqual(store.getHistory('C1', 'T1'), h1);
    assert.deepStrictEqual(store.getHistory('C1', 'T2'), h2);
  });

  it('expires entries after TTL', async () => {
    const shortStore = new SessionStore(0);
    shortStore.setHistory('C1', 'T1', sampleHistory);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(shortStore.getHistory('C1', 'T1'), null);
  });

  it('evicts oldest entries when max is exceeded', () => {
    const smallStore = new SessionStore(86400, 2);
    smallStore.setHistory('C1', 'T1', [{ role: 'user', parts: [{ text: '1' }] }]);
    smallStore.setHistory('C1', 'T2', [{ role: 'user', parts: [{ text: '2' }] }]);
    smallStore.setHistory('C1', 'T3', [{ role: 'user', parts: [{ text: '3' }] }]);
    assert.strictEqual(smallStore.getHistory('C1', 'T1'), null);
    assert.deepStrictEqual(smallStore.getHistory('C1', 'T2'), [{ role: 'user', parts: [{ text: '2' }] }]);
    assert.deepStrictEqual(smallStore.getHistory('C1', 'T3'), [{ role: 'user', parts: [{ text: '3' }] }]);
  });

  it('overwrites existing key', () => {
    const old = [{ role: 'user', parts: [{ text: 'old' }] }];
    const updated = [{ role: 'user', parts: [{ text: 'new' }] }];
    store.setHistory('C1', 'T1', old);
    store.setHistory('C1', 'T1', updated);
    assert.deepStrictEqual(store.getHistory('C1', 'T1'), updated);
  });
});
