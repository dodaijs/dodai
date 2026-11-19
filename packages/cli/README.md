# @dodaijs/cli

The `dodai` command: diff schemas, gate CI on schema changes, verify that every past schema converges, and generate row types.

```sh
npm install -D @dodaijs/cli
```

```sh
dodai --check -f src/schema.sql current.sql
dodai --verify -f src/schema.sql past/*.sql
dodai --types --standard-schema < src/schema.sql > src/schema.gen.ts
```

See the [dodai README](https://github.com/dodaijs/dodai#readme) for the full guide.
