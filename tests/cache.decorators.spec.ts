import test from 'node:test';
import assert from 'node:assert';
import { Cacheable, CacheEvict, CachePut, MemoryCacheStore, defaultCacheStore } from '../src/cache';

test('Cache Framework & Decorators', async (t) => {
  const store = new MemoryCacheStore();

  class TestService {
    public fetchCount = 0;
    public saveCount = 0;

    @Cacheable({ key: 'test:item', store, clone: true })
    async getItem(): Promise<{ id: number; name: string }> {
      this.fetchCount++;
      return { id: 1, name: 'Initial' };
    }

    @Cacheable({
      key: 'test:conditional',
      condition: (force) => !force,
      store,
    })
    async getConditional(force = false): Promise<string> {
      this.fetchCount++;
      return `value_${this.fetchCount}`;
    }

    @Cacheable({
      key: (id: number) => `test:dynamic:${id}`,
      store,
    })
    async getDynamic(id: number): Promise<string> {
      this.fetchCount++;
      return `item_${id}`;
    }

    @Cacheable({
      key: 'test:ttl',
      ttlMs: 50,
      store,
    })
    async getWithTtl(): Promise<number> {
      this.fetchCount++;
      return Date.now();
    }

    @CachePut({
      key: 'test:item',
      value: (res, newName) => ({ id: 1, name: newName }),
      store,
    })
    async updateItem(newName: string): Promise<boolean> {
      this.saveCount++;
      return true;
    }

    @CacheEvict({ key: 'test:item', store })
    async evictItem(): Promise<void> {
      // evicted
    }

    @CacheEvict({ prefix: 'test:', store })
    async evictAllTest(): Promise<void> {
      // evicted all test:
    }
  }

  await t.test('Cacheable caches async method results on subsequent calls', async () => {
    store.clear();
    const service = new TestService();

    // Call 1: Miss
    const res1 = await service.getItem();
    assert.strictEqual(service.fetchCount, 1);
    assert.strictEqual(res1.name, 'Initial');

    // Call 2: Hit (count remains 1)
    const res2 = await service.getItem();
    assert.strictEqual(service.fetchCount, 1);
    assert.strictEqual(res2.name, 'Initial');

    // Mutation of cloned object doesn't affect cache
    res1.name = 'Mutated';
    const res3 = await service.getItem();
    assert.strictEqual(res3.name, 'Initial');
  });

  await t.test('condition bypasses cache when evaluating to false (e.g. force = true)', async () => {
    store.clear();
    const service = new TestService();

    // Call 1: force = false (caches value_1)
    const res1 = await service.getConditional(false);
    assert.strictEqual(res1, 'value_1');
    assert.strictEqual(service.fetchCount, 1);

    // Call 2: force = false (hit, returns cached value_1)
    const res2 = await service.getConditional(false);
    assert.strictEqual(res2, 'value_1');
    assert.strictEqual(service.fetchCount, 1);

    // Call 3: force = true (bypasses cache, calls method, updates cache to value_2)
    const res3 = await service.getConditional(true);
    assert.strictEqual(res3, 'value_2');
    assert.strictEqual(service.fetchCount, 2);

    // Call 4: force = false (hit, returns newly cached value_2)
    const res4 = await service.getConditional(false);
    assert.strictEqual(res4, 'value_2');
    assert.strictEqual(service.fetchCount, 2);
  });

  await t.test('dynamic key generation from method arguments', async () => {
    store.clear();
    const service = new TestService();

    const item10 = await service.getDynamic(10);
    assert.strictEqual(item10, 'item_10');
    assert.strictEqual(service.fetchCount, 1);

    const item20 = await service.getDynamic(20);
    assert.strictEqual(item20, 'item_20');
    assert.strictEqual(service.fetchCount, 2);

    // Repeat item 10: Hit
    const item10Again = await service.getDynamic(10);
    assert.strictEqual(item10Again, 'item_10');
    assert.strictEqual(service.fetchCount, 2);
  });

  await t.test('TTL expiration', async () => {
    store.clear();
    const service = new TestService();

    const t1 = await service.getWithTtl();
    assert.strictEqual(service.fetchCount, 1);

    // Immediate call: hit
    const t2 = await service.getWithTtl();
    assert.strictEqual(t2, t1);
    assert.strictEqual(service.fetchCount, 1);

    // Wait past TTL (60ms)
    await new Promise((resolve) => setTimeout(resolve, 60));

    const t3 = await service.getWithTtl();
    assert.strictEqual(service.fetchCount, 2);
    assert.ok(t3 >= t1);
  });

  await t.test('CachePut updates cache with transformed value', async () => {
    store.clear();
    const service = new TestService();

    await service.getItem(); // Populates cache with 'Initial'
    assert.strictEqual(service.fetchCount, 1);

    await service.updateItem('UpdatedViaPut');
    assert.strictEqual(service.saveCount, 1);

    // Next getItem returns updated value without re-fetching
    const res = await service.getItem();
    assert.strictEqual(res.name, 'UpdatedViaPut');
    assert.strictEqual(service.fetchCount, 1);
  });

  await t.test('CacheEvict removes key or prefix', async () => {
    store.clear();
    const service = new TestService();

    await service.getItem();
    assert.strictEqual(service.fetchCount, 1);

    await service.evictItem();
    assert.strictEqual(store.has('test:item'), false);

    // Next read re-fetches
    await service.getItem();
    assert.strictEqual(service.fetchCount, 2);

    // Prefix eviction
    await service.getDynamic(1);
    assert.ok(store.size() >= 2);
    await service.evictAllTest();
    assert.strictEqual(store.size(), 0);
  });
});
