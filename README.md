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
});
```

- `redisUrl` (**required**): The Redis connection URL.
- `enabled` (optional): Enable or disable caching globally (default: `true`).
- `excludedPaths` (optional): Array of route prefixes to exclude from caching.

The `Config` class provides static methods to set and get configuration values:

```ts
Config.set(key, value);      // Set a config value by key
Config.get(key);             // Get a config value by key
Config.register({ key, value }); // Register a config object with a unique key
```

## Usage

### Global usage:

```
const YOURAPI = new BreezeAPI({
    title: 'your-api',
...
});

// Set your cache config
Config.set('breezeCache', { redisUrl: 'redis://localhost:6379' });

// Use it globaly
YOURAPI.use(cacheMiddleware({duration:"5s"}))