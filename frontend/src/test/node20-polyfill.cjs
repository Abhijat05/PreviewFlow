// frontend/src/test/node20-polyfill.cjs
/**
 * Polyfills for Node.js <= 20 environments:
 * 1. node:worker_threads.markAsUncloneable (added in Node 21) - required by Undici v8 / JSDOM.
 * 2. node:zlib.createZstdDecompress (added in Node 22) - required by Undici decompress.
 */
const workerThreads = require("node:worker_threads");
if (typeof workerThreads.markAsUncloneable !== "function") {
  workerThreads.markAsUncloneable = function (obj) {
    return obj;
  };
}

const zlib = require("node:zlib");
const { PassThrough } = require("node:stream");

if (!zlib.createZstdDecompress) {
  zlib.createZstdDecompress = function () {
    return new PassThrough();
  };
  zlib.constants = zlib.constants || {};
  if (zlib.constants.ZSTD_d_windowLogMax === undefined) {
    zlib.constants.ZSTD_d_windowLogMax = 0;
  }
}
