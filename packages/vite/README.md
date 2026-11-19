# @dodaijs/vite

Vite plugin for dodai: import `.sql` schemas, fail the build on schemas dodai cannot read, and keep their row types up to date.

```sh
npm install -D @dodaijs/vite
```

```ts
import { dodai } from "@dodaijs/vite";

export default defineConfig({ plugins: [dodai({ types: { standardSchema: true } })] });
```

See the [dodai README](https://github.com/dodaijs/dodai#readme) for the full guide.
