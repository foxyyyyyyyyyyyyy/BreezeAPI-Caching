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
    duration: z.number().int().positive(), // Cache duration in seconds
});

/**
 * Zod schema for global breezeCache configuration.
 * - redisUrl: Redis connection URL (required).
 * - enabled: Enable or disable caching globally.
 * - excludedPaths: Optional array of route prefixes to exclude from caching.
 */
export const breezeCacheConfigSchema = z.object({
    redisUrl: z.string().url(), // required Redis URL
    enabled: z.boolean().default(true), // Caching active or not
    excludedPaths: z.array(z.string()).optional(), // Optional: excluded routes for caching
});

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
export function cacheMiddleware(conf: z.infer<typeof cacheConfigSchema>) {
    return async (req: apiRequest, res: apiResponse, next: apiNext) => {
        const BreezeConfig = Config.get('breezeCache');

        // Validate config
        const parseResult = breezeCacheConfigSchema.safeParse(BreezeConfig);
        if (!parseResult.success) {
            console.error("[BREEZEAPI - CACHING] Invalid config:", parseResult.error);
            return next();
        }
        const { redisUrl, enabled, excludedPaths } = parseResult.data;

        if (!redisUrl) {
            console.error("[BREEZEAPI - CACHING] No redisUrl provided in config.");
            return next();
        }

        if (enabled === false) {
            console.warn("[BREEZEAPI - CACHING] Caching is disabled via config.");
            return next();
        }

        // Exclude paths if needed
        if (excludedPaths && excludedPaths.some(path => req.url.startsWith(path))) {
            return next();
        }

        // Use a dedicated Redis client for this config
        const client = new RedisClient(redisUrl);

        const cacheKey = req.url;
        const cached = await client.get(cacheKey);
        if (cached) {
            try {
                res.header?.("X-BREEZEAPI-CACHE", "HIT");
                return res.json(JSON.parse(cached));
            } catch (e) {
                // If cache is corrupted, ignore and proceed
                console.warn("[breezeCache] Failed to parse cached value for", cacheKey, e);
            }
        }

        // Wrap res.json to cache the response after handler runs
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            // Support duration as string (e.g. "5s", "2h") or number (seconds)
            let durationSeconds = 60;
            if (conf?.duration !== undefined) {
                if (typeof conf.duration === "string") {
                    // parseDuration returns ms, convert to seconds
                    durationSeconds = Math.floor(parseDuration(conf.duration) / 1000);
                } else if (typeof conf.duration === "number") {
                    durationSeconds = conf.duration;
                }
            }
            client.set(cacheKey, JSON.stringify(body));
            client.expire(cacheKey, durationSeconds);
            res.header?.("X-BREEZEAPI-CACHE", "MISS");
            return originalJson(body);
        };

        return next();
    };
}