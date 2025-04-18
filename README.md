# breezeapi-caching

To install the Plugin:

```bash
bun add @breezeapi/cache
```

## Configuration

Before using the caching middleware, you must set the `breezeCache` config in your BreezeAPI project.  
Use the `Config` class to set the configuration, for example in your server setup:

```ts
import { Config } from '@breezeapi/core';

Config.set('breezeCache', {
  redisUrl: 'redis://localhost:6379', // required
  enabled: true,                      // optional, default: true
  excludedPaths: ['/auth', '/admin'], // optional, array of route prefixes to exclude from caching. These are only needed when using it as global caching
  debug: true,                        // optional, enables debug logging
});
```

- `redisUrl` (**required**): The Redis connection URL.
- `enabled` (optional): Enable or disable caching globally (default: `true`).
- `excludedPaths` (optional): Array of route prefixes to exclude from caching.
- `debug` (optional): Enable debug logging for cache operations.

The `Config` class provides static methods to set and get configuration values:

```ts
Config.set(key, value);      // Set a config value by key
Config.get(key);             // Get a config value by key
Config.register({ key, value }); // Register a config object with a unique key
```

## Usage

### Global usage

```ts
import { cacheMiddleware } from '@breezeapi/cache';
import { Config } from '@breezeapi/core';

const YOURAPI = new BreezeAPI({
    title: 'your-api',
    // ...
});

// Set your cache config
Config.set('breezeCache', { redisUrl: 'redis://localhost:6379' });

// Use it globally
YOURAPI.use(cacheMiddleware({ duration: "5s" }));
```

### Per-route usage

```ts
import { cacheMiddleware } from '@breezeapi/cache';

export const config = {
  get: {
    middleware: [
      cacheMiddleware({
        enabled: true,
        duration: '1h',
      }),
    ],
  },
};
```

## How to cache a response in your handler

You can use the `.cache()` method on the response returned by `res.json()` for full type safety and runtime support:

```ts
import type { ApiResponseWithCache } from '@breezeapi/cache';

export async function GET(req, res): Promise<ApiResponseWithCache> {
  return await res.json({ hello: "world" }).cache();
}
```

- `.cache()` will cache the response using the config provided to the middleware.
- The return type `ApiResponseWithCache` gives you full autocompletion and type safety for `.cache()`.

## Manual cache set (advanced)

If you want to manually set the cache (for example, with a custom key or outside of `res.json()`), you can use:

```ts
import { setCache } from '@breezeapi/cache';

export async function GET(req, res) {
  const body = { hello: "manual cache" };
  await setCache(req, res, { duration: "10m" }, body);
  return res.json(body);
}
```

## Utility types

- `ApiResponseWithCache`: Use as the return type of your handler for full `.cache()` support.

---

This project was created using `bun init` in bun v1.2.9. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.