/**
 * Lightweight In-Memory Cache Store with TTL and Prefix Eviction support.
 * Zero external dependencies.
 */

export interface CacheEntry<T = any> {
  value: T;
  expiresAt: number | null; // Milliseconds timestamp, or null for indefinite
}

export class MemoryCacheStore {
  private readonly store = new Map<string, CacheEntry>();

  /**
   * Retrieve cached value by key. Returns undefined if missing or expired.
   */
  get<T = any>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * Check if a non-expired key exists in cache.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Store a value with optional TTL in milliseconds.
   */
  set<T = any>(key: string, value: T, ttlMs?: number): void {
    const expiresAt = typeof ttlMs === 'number' && ttlMs > 0 ? Date.now() + ttlMs : null;
    this.store.set(key, { value, expiresAt });
  }

  /**
   * Delete a specific cache key.
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Delete all keys starting with a given prefix.
   */
  deletePrefix(prefix: string): number {
    let deletedCount = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Return total count of active, unexpired keys.
   */
  size(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt === null || entry.expiresAt > now) {
        count++;
      } else {
        this.store.delete(key);
      }
    }
    return count;
  }

  /**
   * Return all active keys.
   */
  keys(): string[] {
    const now = Date.now();
    const active: string[] = [];
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt === null || entry.expiresAt > now) {
        active.push(key);
      } else {
        this.store.delete(key);
      }
    }
    return active;
  }
}

/**
 * Global default cache store singleton instance.
 */
export const defaultCacheStore = new MemoryCacheStore();
