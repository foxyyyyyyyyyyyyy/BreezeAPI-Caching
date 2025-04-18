import { Config, type apiRequest, type apiResponse, type apiNext } from '@breezeapi/core';
import { z } from 'zod';
import { redis, RedisClient } from "bun";
import { parseDuration } from './parseDuration'; // <-- Add this import

/**
 * Zod schema for per-route cache configuration.
 * - enabled: Enable or disable caching for this route.
 * - cacheKey: Optional custom cache key. If not provided, the URL will be used.
 * - duration: Cache duration in seconds.
 */
export const cacheConfigSchema = z.object({
    enabled: z.boolean().default(true), // Caching active or not
    cacheKey: z.string().optional(), // Optional cache key for custom cache key generation if nothing is provided, the URL will be used as the cache key 
    duration: z.string(), // Cache duration as a string (e.g. "5s", "2h")
});

/**
 * Zod schema for global breezeCache configuration.
 * - redisUrl: Redis connection URL (required).
 * - enabled: Enable or disable caching globally.
 * - excludedPaths: Optional array of route prefixes to exclude from caching.
 * - debug: Optional flag to enable debug logging.
 */
export const breezeCacheConfigSchema = z.object({
    redisUrl: z.string().url(), // required Redis URL
    enabled: z.boolean().default(true), // Caching active or not
    excludedPaths: z.array(z.string()).optional(), // Optional: excluded routes for caching
    debug: z.boolean().optional(), // <-- Add debug flag
});

// Track initialization state
let _cacheInitialized = false;
let _sharedRedisClient: RedisClient | null = null;
let _sharedRedisUrl: string | null = null;

export function isCacheInitialized(): boolean {
    return _cacheInitialized;
}

/**
 * Optionally initialize and reuse a single Redis connection for all cache operations.
 * Call this at startup if you want to share a Redis connection.
 * If not called, the middleware will create a new RedisClient per request.
 */
export function initializeCache() {
    const BreezeConfig = Config.get('breezeCache');
    const parseResult = breezeCacheConfigSchema.safeParse(BreezeConfig);
    if (!parseResult.success) {
        throw new Error("[BREEZEAPI - CACHING] Invalid config: " + parseResult.error);
    }
    const { redisUrl, debug } = parseResult.data;
    if (!redisUrl) {
        throw new Error("[BREEZEAPI - CACHING] No redisUrl provided in config.");
    }
    if (_sharedRedisClient && _sharedRedisUrl === redisUrl) {
        // Already initialized with same URL
        return;
    }
    // If changing Redis URL, close previous shared client
    if (_sharedRedisClient && _sharedRedisUrl && _sharedRedisUrl !== redisUrl) {
        if (debug) console.log("[BREEZEAPI - CACHING] Closing previous shared Redis client");
        try { _sharedRedisClient.close?.(); } catch {}
    }
    _sharedRedisClient = new RedisClient(redisUrl);
    _sharedRedisUrl = redisUrl;
    _cacheInitialized = true;
}

/**
 * BreezeAPI cache middleware.
 * 
 * Checks the global breezeCache config for Redis connection and caching options.
 * If caching is enabled and the route is not excluded, attempts to serve from cache.
 * Otherwise, wraps the response to cache the result after the handler runs.
 * 
 * Adds the `X-BREEZEAPI-CACHE` header with value "HIT" or "MISS" to indicate cache status.
 * 
 * @param conf - Per-route cache configuration (see cacheConfigSchema)
 * @returns Middleware function for BreezeAPI
 */
export type CachedResponse<T = any> = T & {
    
    cache: () => Promise<T>;
};

/**
 * Type for a BreezeAPI response with cache() support.
 * Use as: Promise<ApiResponseWithCache>
 */
export type ApiResponseWithCache = ReturnType<apiResponse['json']> & {
    cache: () => Promise<ReturnType<apiResponse['json']>>;
};

export function cacheMiddleware(conf: z.infer<typeof cacheConfigSchema>) {
    return async (req: apiRequest, res: apiResponse, next: apiNext) => {
        const BreezeConfig = Config.get('breezeCache');

        // Validate config
        const parseResult = breezeCacheConfigSchema.safeParse(BreezeConfig);
        if (!parseResult.success) {
            console.error("[BREEZEAPI - CACHING] Invalid config:", parseResult.error);
            _cacheInitialized = false;
            return next();
        }
        const { redisUrl, enabled, excludedPaths, debug } = parseResult.data;

        if (!redisUrl) {
            console.error("[BREEZEAPI - CACHING] No redisUrl provided in config.");
            _cacheInitialized = false;
            return next();
        }

        if (enabled === false) {
            if (debug) console.log("[BREEZEAPI - CACHING] Caching is disabled via config.");
            _cacheInitialized = false;
            return next();
        }

        // Exclude paths if needed
        if (excludedPaths && excludedPaths.some(path => req.url.startsWith(path))) {
            if (debug) console.log(`[BREEZEAPI - CACHING] Path excluded from cache: ${req.url}`);
            return next();
        }

        // Use shared Redis client if initialized, else create a new one
        let client: RedisClient;
        let shouldCloseClient = false;
        if (_sharedRedisClient && _sharedRedisUrl === redisUrl) {
            client = _sharedRedisClient;
            _cacheInitialized = true;
        } else {
            client = new RedisClient(redisUrl);
            _cacheInitialized = true;
            shouldCloseClient = true;
        }

        const cacheKey = req.url;
        if (debug) console.log(`[BREEZEAPI - CACHING] Checking cache for key: ${cacheKey}`);

        // Patch res.json BEFORE cache check so .cache() is always available
        const originalJson = res.json.bind(res);
        let alreadyCached = false;
        let cacheHitValue: any = undefined;
        let cacheHit = false;
        res.json = (body: any) => {
            // If cache HIT, always return the cached value and .cache() is a no-op
            if (cacheHit) {
                const response = originalJson(cacheHitValue);
                Object.defineProperty(response, "cache", {
                    value: async () => {
                        if (debug) console.log(`[BREEZEAPI - CACHING] (json.cache) No-op: already cached for key: ${cacheKey}`);
                        return response;
                    },
                    enumerable: false,
                    configurable: true,
                    writable: false
                });
                return response as ApiResponseWithCache;
            }
            const response = originalJson(body);
            Object.defineProperty(response, "cache", {
                value: async () => {
                    if (alreadyCached) {
                        if (debug) console.log(`[BREEZEAPI - CACHING] (json.cache) Skipping cache: already cached for key: ${cacheKey}`);
                        return response;
                    }
                    alreadyCached = true;
                    let durationSeconds = 60;
                    if (conf?.duration !== undefined) {
                        if (typeof conf.duration === "string") {
                            durationSeconds = Math.floor(parseDuration(conf.duration) / 1000);
                        } else if (typeof conf.duration === "number") {
                            durationSeconds = conf.duration;
                        }
                    }
                    if (debug) {
                        console.log(`[BREEZEAPI - CACHING] (json.cache) Caching response for key: ${cacheKey} for ${durationSeconds}s`);
                    }
                    try {
                        await client.set(cacheKey, JSON.stringify(body));
                        await client.expire(cacheKey, durationSeconds);
                    } catch (err) {
                        if (debug) console.error("[BREEZEAPI - CACHING] Redis SET/EXPIRE error:", err);
                    }
                    // Only close per-request clients, never the shared client
                    if (shouldCloseClient && typeof client.close === "function") {
                        if (debug) console.log("[BREEZEAPI - CACHING] Closing per-request Redis client");
                        try { await client.close(); } catch {}
                    }
                    res.header?.("X-BREEZEAPI-CACHE", "MISS");
                    return response;
                },
                enumerable: false,
                configurable: true,
                writable: false
            });
            return response as ApiResponseWithCache;
        };

        let cached: string | null = null;
        let retried = false;
        async function tryGetCache() {
            try {
                cached = await client.get(cacheKey);
                return true;
            } catch (err: any) {
                if (err?.code === "ERR_REDIS_CONNECTION_CLOSED") {
                    if (debug) console.warn("[BREEZEAPI - CACHING] Redis connection closed, will attempt to reconnect.");
                } else {
                    if (debug) console.error("[BREEZEAPI - CACHING] Redis GET error:", err);
                }
                // If connection closed, try to reopen ONCE
                if (!retried && err?.code === "ERR_REDIS_CONNECTION_CLOSED") {
                    retried = true;
                    if (shouldCloseClient && typeof client.close === "function") {
                        if (debug) console.log("[BREEZEAPI - CACHING] Closing per-request Redis client after connection closed");
                        try { await client.close(); } catch {}
                    }
                    // Recreate client
                    if (shouldCloseClient) {
                        client = new RedisClient(redisUrl);
                    } else if (_sharedRedisClient && _sharedRedisUrl === redisUrl) {
                        if (debug) console.log("[BREEZEAPI - CACHING] Reopening shared Redis client after connection closed");
                        _sharedRedisClient = new RedisClient(redisUrl);
                        client = _sharedRedisClient;
                    }
                    // Try again
                    try {
                        cached = await client.get(cacheKey);
                        return true;
                    } catch (err2: any) {
                        if (debug) console.error("[BREEZEAPI - CACHING] Redis GET retry failed:", err2);
                        // Give up, skip cache
                        return false;
                    }
                }
                // Give up, skip cache
                return false;
            }
        }
        const cacheOk = await tryGetCache();
        if (!cacheOk) {
            // Only close per-request clients, never the shared client
            if (shouldCloseClient && typeof client.close === "function") {
                if (debug) console.log("[BREEZEAPI - CACHING] Closing per-request Redis client after cache fail");
                try { await client.close(); } catch {}
            }
            return next();
        }
        if (cached) {
            try {
                alreadyCached = true;
                cacheHit = true;
                cacheHitValue = JSON.parse(cached);
                if (debug) console.log(`[BREEZEAPI - CACHING] Cache HIT for key: ${cacheKey}`);
                res.header?.("X-BREEZEAPI-CACHE", "HIT");
                // Only close per-request clients, never the shared client
                if (shouldCloseClient && typeof client.close === "function") {
                    if (debug) console.log("[BREEZEAPI - CACHING] Closing per-request Redis client");
                    try { await client.close(); } catch {}
                }
            } catch (e) {
                // If cache is corrupted, ignore and proceed
                console.warn("[breezeCache] Failed to parse cached value for", cacheKey, e);
            }
        } else {
            if (debug) console.log(`[BREEZEAPI - CACHING] Cache MISS for key: ${cacheKey}`);
        }

        return next();
    };
}

