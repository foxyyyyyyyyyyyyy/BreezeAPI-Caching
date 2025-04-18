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
    const { redisUrl } = parseResult.data;
    if (!redisUrl) {
        throw new Error("[BREEZEAPI - CACHING] No redisUrl provided in config.");
    }
    if (_sharedRedisClient && _sharedRedisUrl === redisUrl) {
        // Already initialized with same URL
        return;
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
        if (_sharedRedisClient && _sharedRedisUrl === redisUrl) {
            client = _sharedRedisClient;
            _cacheInitialized = true;
        } else {
            client = new RedisClient(redisUrl);
            _cacheInitialized = true;
        }

        const cacheKey = req.url;
        if (debug) console.log(`[BREEZEAPI - CACHING] Checking cache for key: ${cacheKey}`);
        const cached = await client.get(cacheKey);
        if (cached) {
            try {
                if (debug) console.log(`[BREEZEAPI - CACHING] Cache HIT for key: ${cacheKey}`);
                res.header?.("X-BREEZEAPI-CACHE", "HIT");
                return res.json(JSON.parse(cached));
            } catch (e) {
                // If cache is corrupted, ignore and proceed
                console.warn("[breezeCache] Failed to parse cached value for", cacheKey, e);
            }
        } else {
            if (debug) console.log(`[BREEZEAPI - CACHING] Cache MISS for key: ${cacheKey}`);
        }

        // Patch res.json to allow .cache() chaining
        const originalJson = res.json.bind(res);
        res.json = (body: any) => {
            const response = originalJson(body);
            // Attach a .cache() method to the returned object
            Object.defineProperty(response, "cache", {
                value: async () => {
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
                    await client.set(cacheKey, JSON.stringify(body));
                    await client.expire(cacheKey, durationSeconds);
                    res.header?.("X-BREEZEAPI-CACHE", "MISS");
                    return response; // <-- Return the response object for chaining
                },
                enumerable: false,
                configurable: true,
                writable: false
            });
            return response as ApiResponseWithCache;
        };

        return next();
    };
}

/**
 * Helper to set the cache for a response manually in a route handler.
 * Call this in your handler to cache the response body.
 * Example:
 *   export async function GET(req, res) {
 *     setCache(req, res, { duration: "1h" }, responseBody);
 *     return res.json(responseBody);
 *   }
 */
export async function setCache(
    req: apiRequest,
    res: apiResponse,
    conf: z.infer<typeof cacheConfigSchema>,
    body: any
) {
    const BreezeConfig = Config.get('breezeCache');
    const parseResult = breezeCacheConfigSchema.safeParse(BreezeConfig);
    if (!parseResult.success) return;
    const { redisUrl, debug } = parseResult.data;
    if (!redisUrl) return;

    let client: RedisClient;
    if (_sharedRedisClient && _sharedRedisUrl === redisUrl) {
        client = _sharedRedisClient;
    } else {
        client = new RedisClient(redisUrl);
    }

    const cacheKey = req.url;
    let durationSeconds = 60;
    if (conf?.duration !== undefined) {
        if (typeof conf.duration === "string") {
            durationSeconds = Math.floor(parseDuration(conf.duration) / 1000);
        } else if (typeof conf.duration === "number") {
            durationSeconds = conf.duration;
        }
    }
    if (debug) {
        console.log(`[BREEZEAPI - CACHING] (setCache) Caching response for key: ${cacheKey} for ${durationSeconds}s`);
    }
    await client.set(cacheKey, JSON.stringify(body));
    await client.expire(cacheKey, durationSeconds);
    res.header?.("X-BREEZEAPI-CACHE", "MISS");
}