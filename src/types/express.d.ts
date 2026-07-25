import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    // Populated by express.json()'s `verify` option in server.ts — the exact
    // bytes Shopify signed, needed because re-serializing the parsed JSON
    // body is not guaranteed to reproduce them byte-for-byte.
    rawBody?: Buffer;
  }
}
