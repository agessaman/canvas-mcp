const FALLBACK_TTL_MS = 30 * 60 * 1000; // hard expiry for entries with no ETag/Last-Modified
const FRESH_MS = 60 * 1000; // serve any cached entry without revalidation for this long
const MAX_ENTRIES = 500; // LRU cap to keep memory bounded on a long-lived server

export interface CacheEntry {
  value: any;
  etag?: string;
  lastModified?: string;
  freshUntil: number; // serve without a network call until this time
  expiresAt: number; // hard expiry, only applied to entries without a validator
}

export class SimpleCache {
  private store = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    const hasValidator = !!(entry.etag || entry.lastModified);
    // TTL only applies when there are no conditional-GET validators
    if (!hasValidator && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Mark as most-recently used (re-insert to move to the end of the Map)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry;
  }

  set(key: string, value: any, etag?: string, lastModified?: string): void {
    const now = Date.now();
    this.store.delete(key);
    this.store.set(key, { value, etag, lastModified, freshUntil: now + FRESH_MS, expiresAt: now + FALLBACK_TTL_MS });
    // Evict the least-recently-used entry (first key) once over capacity
    if (this.store.size > MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  // Whether an entry can be served without revalidating against Canvas
  isFresh(entry: CacheEntry): boolean {
    return Date.now() < entry.freshUntil;
  }

  /**
   * Drop everything. This exists because a cached read is indistinguishable
   * from a resource that does not exist, and nothing on the write side can
   * help when the edit was made *outside* this session — in the Canvas UI, by
   * a co-teacher, or by Canvas itself finishing a background job.
   *
   * Found the hard way: a question attached to a stimulus in the Canvas UI kept
   * not appearing in a cached item listing, and was nearly recorded as "the API
   * does not expose attached questions". It had been there the whole time.
   *
   * Returns how many entries were dropped, so a caller can say something
   * truthful about what it did rather than claiming a refresh it cannot see.
   */
  clear(): number {
    const dropped = this.store.size;
    this.store.clear();
    return dropped;
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /**
   * Drop every entry whose URL contains `fragment`, for resources that are
   * listed under a different path than they are written to. A file is written
   * at /files/:id but listed under /courses/:id/files and /folders/:id/files,
   * so prefix invalidation alone leaves those listings stale.
   */
  invalidateContaining(fragment: string): void {
    for (const key of this.store.keys()) {
      if (key.includes(fragment)) this.store.delete(key);
    }
  }
}
