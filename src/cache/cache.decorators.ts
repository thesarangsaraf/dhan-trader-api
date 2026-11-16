import { defaultCacheStore, MemoryCacheStore } from './cache.store';

export type KeyGenerator = string | ((...args: any[]) => string);
export type ConditionFn = (...args: any[]) => boolean;

export interface CacheableOptions {
  /**
   * Static key or function deriving a cache key from method arguments.
   */
  key: KeyGenerator;

  /**
   * Time-To-Live in milliseconds. Default: Infinity (until evicted).
   */
  ttlMs?: number;

  /**
   * Predicate evaluated before reading from cache.
   * If returns false, cache read is bypassed (original method executes and refreshes cache).
   * E.g. `condition: (force) => !force`
   */
  condition?: ConditionFn;

  /**
   * If true, deep clones the cached object before returning (prevents accidental mutation).
   */
  clone?: boolean;

  /**
   * If true, null values are not stored in cache. Default: false.
   */
  skipNull?: boolean;

  /**
   * Custom cache store instance. Defaults to defaultCacheStore singleton.
   */
  store?: MemoryCacheStore;
}

export interface CacheEvictOptions {
  /**
   * Specific key or key generator to evict.
   */
  key?: KeyGenerator;

  /**
   * Prefix of keys to evict (e.g., 'config:').
   */
  prefix?: string;

  /**
   * If true, evicts all entries in the store.
   */
  allEntries?: boolean;

  /**
   * If true, evicts before running the method. Default: false (evicts after successful execution).
   */
  beforeInvocation?: boolean;

  /**
   * Custom cache store instance. Defaults to defaultCacheStore singleton.
   */
  store?: MemoryCacheStore;
}

export interface CachePutOptions {
  /**
   * Key or key generator to store.
   */
  key: KeyGenerator;

  /**
   * Time-To-Live in milliseconds. Default: Infinity.
   */
  ttlMs?: number;

  /**
   * Custom value extractor: `(methodResult, ...args) => valueToCache`.
   * Defaults to caching methodResult directly.
   */
  value?: (result: any, ...args: any[]) => any;

  /**
   * Optional condition to check if value should be cached: `(result, ...args) => boolean`.
   */
  condition?: (result: any, ...args: any[]) => boolean;

  /**
   * Custom cache store instance. Defaults to defaultCacheStore singleton.
   */
  store?: MemoryCacheStore;
}

function resolveKey(keyGen: KeyGenerator, args: any[]): string {
  return typeof keyGen === 'function' ? keyGen(...args) : keyGen;
}

function cloneValue<T>(val: T): T {
  if (val && typeof val === 'object') {
    if (typeof structuredClone === 'function') {
      return structuredClone(val);
    }
    return JSON.parse(JSON.stringify(val));
  }
  return val;
}

/**
 * Spring-style @Cacheable method decorator.
 * Caches method return value in memory based on key.
 * Subsequent calls with cache hits return instantly without executing method body.
 */
export function Cacheable(options: CacheableOptions): MethodDecorator {
  return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const store = options.store || defaultCacheStore;

    descriptor.value = function (...args: any[]) {
      const key = resolveKey(options.key, args);
      const shouldReadCache = options.condition ? options.condition(...args) : true;

      const isPromiseReturn =
        originalMethod.constructor?.name === 'AsyncFunction' ||
        (typeof Reflect !== 'undefined' &&
          typeof Reflect.getMetadata === 'function' &&
          Reflect.getMetadata('design:returntype', target, propertyKey) === Promise);

      if (shouldReadCache && store.has(key)) {
        const cached = store.get(key);
        const returnVal = options.clone ? cloneValue(cached) : cached;
        return isPromiseReturn ? Promise.resolve(returnVal) : returnVal;
      }

      const result = originalMethod.apply(this, args);

      if (result && typeof result.then === 'function') {
        return (result as Promise<any>).then((resolvedVal) => {
          if (resolvedVal !== undefined && (!options.skipNull || resolvedVal !== null)) {
            store.set(key, resolvedVal, options.ttlMs);
          }
          return options.clone ? cloneValue(resolvedVal) : resolvedVal;
        });
      }

      if (result !== undefined && (!options.skipNull || result !== null)) {
        store.set(key, result, options.ttlMs);
      }
      return options.clone ? cloneValue(result) : result;
    };

    return descriptor;
  };
}

/**
 * Spring-style @CacheEvict method decorator.
 * Removes entries from cache after (or before) method invocation.
 */
export function CacheEvict(options: CacheEvictOptions): MethodDecorator {
  return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const store = options.store || defaultCacheStore;

    const performEviction = (args: any[]) => {
      if (options.allEntries) {
        store.clear();
      } else if (options.prefix) {
        store.deletePrefix(options.prefix);
      } else if (options.key) {
        const key = resolveKey(options.key, args);
        store.delete(key);
      }
    };

    descriptor.value = function (...args: any[]) {
      if (options.beforeInvocation) {
        performEviction(args);
      }

      const result = originalMethod.apply(this, args);

      if (result && typeof result.then === 'function') {
        return (result as Promise<any>).then((resolvedVal) => {
          if (!options.beforeInvocation) {
            performEviction(args);
          }
          return resolvedVal;
        });
      }

      if (!options.beforeInvocation) {
        performEviction(args);
      }
      return result;
    };

    return descriptor;
  };
}

/**
 * Spring-style @CachePut method decorator.
 * Executes method and always updates the cache entry with the result (or transformed value).
 */
export function CachePut(options: CachePutOptions): MethodDecorator {
  return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const store = options.store || defaultCacheStore;

    const performPut = (resultVal: any, args: any[]) => {
      if (options.condition && !options.condition(resultVal, ...args)) {
        return;
      }
      const key = resolveKey(options.key, args);
      const valToCache = options.value ? options.value(resultVal, ...args) : resultVal;
      if (valToCache !== undefined) {
        store.set(key, valToCache, options.ttlMs);
      }
    };

    descriptor.value = function (...args: any[]) {
      const result = originalMethod.apply(this, args);

      if (result && typeof result.then === 'function') {
        return (result as Promise<any>).then((resolvedVal) => {
          performPut(resolvedVal, args);
          return resolvedVal;
        });
      }

      performPut(result, args);
      return result;
    };

    return descriptor;
  };
}
