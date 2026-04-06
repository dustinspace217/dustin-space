/**
 * middleware/csrf.js — Origin-check CSRF protection for mutation routes
 *
 * Protects against cross-site request forgery on the ingest server.
 * Multipart form POSTs (like the file upload to /api/process) are "simple
 * requests" in CORS terms — they don't trigger a preflight OPTIONS check.
 * That means any website the user visits could POST to localhost:3333 while
 * the ingest server is running. This middleware blocks that by checking the
 * Origin (or Referer) header on all mutation methods (POST, PUT, DELETE).
 *
 * GET, HEAD, and OPTIONS are exempt — they should be read-only by convention.
 *
 * Allowed origins: http://localhost:* and http://127.0.0.1:* (any port).
 * Requests with no Origin header are allowed — these come from curl, Postman,
 * or other non-browser tools that can't be exploited for CSRF anyway.
 *
 * Usage in server.js:
 *   const csrfCheck = require('./middleware/csrf');
 *   app.use('/api', csrfCheck);
 */

'use strict';

/**
 * csrfCheck — Express middleware that rejects cross-origin mutation requests.
 *
 * @param {object} req — Express request object
 * @param {object} res — Express response object
 * @param {function} next — Express next() callback to continue the middleware chain
 */
function csrfCheck(req, res, next) {
	// Allow safe methods through — these should not modify state.
	if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
		return next();
	}

	// The Origin header is the primary check. Browsers always send it on
	// cross-origin requests. The Referer header is a fallback for older
	// browser behavior. If neither is present, the request came from a
	// non-browser client (curl, Postman) — these are not CSRF vectors.
	const origin = req.get('Origin') || req.get('Referer') || '';

	// No origin header = non-browser client → allow through.
	if (!origin) {
		return next();
	}

	// Check that the origin starts with a localhost variant.
	// Match http://localhost:NNNN or http://127.0.0.1:NNNN (any port).
	if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
		return next();
	}

	// Origin is present but doesn't match localhost → reject.
	return res.status(403).json({ error: 'CSRF: origin mismatch' });
}

module.exports = csrfCheck;
