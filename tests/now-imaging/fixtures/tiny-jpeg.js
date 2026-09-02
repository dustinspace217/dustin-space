/**
 * tests/now-imaging/fixtures/tiny-jpeg.js — one real 1x1 BASELINE JPEG
 * (SOF0 = 0xFFC0), 315 bytes, as base64.
 *
 * Generated with `vips black /tmp/claude/one.jpg 1 1` then `vips copy … [strip]`
 * to drop the Exif block, and verified with `file` (reports "baseline,
 * precision 8, 1x1"). Real bytes rather than a hand-written string on purpose:
 * a fabricated one would make every jpegDimensions assertion vacuous or false.
 *
 * A module rather than a copied constant because two suites need the same
 * bytes: nina.test.js decodes and measures it, and agent-check.test.js feeds it
 * through the whole publish path as the frame a fake NINA returns.
 */
'use strict';

const TINY_JPEG_B64 = '/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z';

module.exports = { TINY_JPEG_B64 };
