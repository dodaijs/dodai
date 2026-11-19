# @dodaijs/core

Declarative schema management for Cloudflare Durable Objects SQLite: converge every object to the schema in your code when it starts.

```sh
npm install @dodaijs/core
```

```ts
import { dodai } from "@dodaijs/core";

ctx.blockConcurrencyWhile(async () => {
  dodai(ctx.storage, SCHEMA);
});
```

See the [dodai README](https://github.com/dodaijs/dodai#readme) for the full guide.
