import express from 'express';

// Express 4 does not route a rejected promise from an async handler to
// error-handling middleware (only Express 5 does) — an unguarded `await`
// that throws becomes an unhandled promise rejection instead, which
// terminates the entire Node process on this version, not just the one
// request (found live in a stress test, 2026-07-30 — CLAUDE.md step 16a).
// Wrap every async route handler/middleware with this so any such rejection
// reaches the app's error-handling middleware (server.ts's final app.use)
// instead of crashing — `next(err)` bubbles up through parent routers
// regardless of which sub-router (e.g. shopifyWebhookRouter) it came from.
// Safe on handlers that already have their own try/catch — it only engages
// if something throws past that.
export function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
