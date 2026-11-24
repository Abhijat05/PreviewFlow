// frontend/src/test/node20-polyfill.cjs
/**
 * Polyfill for Node.js 20 environments where node:zlib lacks createZstdDecompress.
 * Undici's decompress.js unconditionally binds createZstdDecompress, crashing on Node <= 20.
 */
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
