import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    // Populated by express.json()'s `verify` option in server.ts — the exact
    // bytes Shopify signed, needed because re-serializing the parsed JSON
    // body is not guaranteed to reproduce them byte-for-byte.
    rawBody?: Buffer;
    // Populated by requireAdminOrMerchantAuth in server.ts — the shop a
    // merchant-scoped request was authorized for (undefined when the global
    // operator key was used with no ?shop=/:shop given, meaning "all shops").
    shopDomain?: string;
  }
}
