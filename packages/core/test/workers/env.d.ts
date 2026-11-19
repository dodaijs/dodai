declare namespace Cloudflare {
  interface Env {
    SCHEMA: DurableObjectNamespace<import("./worker.js").SchemaDO>;
  }
}
