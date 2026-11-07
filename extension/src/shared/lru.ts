/**
 * SubTrans Extension — LRU Cache
 * Port từ lru_cache.go, sử dụng Map để duy trì thứ tự truy cập
 */

export class LRUCache<K = string, V = string> {
  private capacity: number;
  private cache: Map<K, V>;
  private hits = 0;
  private misses = 0;
  private evicts = 0;

  constructor(capacity = 8000) {
    this.capacity = capacity > 0 ? capacity : 8000;
    this.cache = new Map();
  }

  public get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      this.misses++;
      return undefined;
    }
    const val = this.cache.get(key)!;
    // Đưa lên vị trí gần nhất (MRU)
    this.cache.delete(key);
    this.cache.set(key, val);
    this.hits++;
    return val;
  }

  public set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.cache.set(key, value);
      return;
    }
    while (this.cache.size >= this.capacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
      this.evicts++;
    }
    this.cache.set(key, value);
  }

  public has(key: K): boolean {
    return this.cache.has(key);
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evicts = 0;
  }

  public stats(): { hits: number; misses: number; evicts: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      evicts: this.evicts,
      size: this.cache.size,
    };
  }
}
