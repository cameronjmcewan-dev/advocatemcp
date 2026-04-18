/**
 * Vitest-time stub for the virtual `cloudflare:workers` module.
 *
 * The real module only exists in the Cloudflare Workers runtime and can't
 * be resolved by Node/Vitest. Our DO classes extend `DurableObject` from
 * this module, so tests that import those classes need a type-compatible
 * base class to instantiate against.
 *
 * Wired via `resolve.alias` in `worker/vitest.config.ts`. Production code
 * always gets the real import from the Workers runtime.
 */
export class DurableObject<E = unknown> {
  constructor(public state: unknown, public env: E) {}
  // Subclasses override this; the base class isn't used at runtime in tests.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fetch(_request: Request): Response | Promise<Response> {
    return new Response("stub", { status: 501 });
  }
}
