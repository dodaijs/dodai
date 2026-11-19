import { DurableObject } from "cloudflare:workers";

export class SchemaDO extends DurableObject {}

export default {
  fetch: () => new Response(null, { status: 404 }),
};
