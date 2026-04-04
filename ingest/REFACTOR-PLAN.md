# Ingest Server Modular Refactor Plan
**Issue:** #54 — Split ingest/server.js (1,065-line monolith) into modules
**Status:** Planned — execute last to avoid context/compaction issues

---

## Current State
`ingest/server.js` contains everything: Express setup, middleware, multer config,
all route handlers, config I/O, Simbad/AstroBin API calls, ASTAP plate solving,
vips DZI generation, R2 upload logic, and the static file server.

## Target Structure
```
ingest/
  server.js              Express app bootstrap + app.listen() (~60 lines)
  routes/
    settings.js          GET/POST /api/settings
    images.js            GET/POST/DELETE /api/images, /api/images/:slug
    upload.js            POST /api/upload (multer config lives here)
    metadata.js          GET /api/simbad/:name, GET /api/astrobin/:id
    platesolve.js        POST /api/platesolve
    tiles.js             POST /api/tiles (vips + R2 upload)
  lib/
    config.js            loadConfig(), saveConfig() with merge logic (#34 fix)
    r2.js                S3Client setup, uploadDir(), deletePrefix()
    astap.js             execFile wrapper, path validation (#52 fix)
    simbad.js            querySimbad() — HTTP client for CDS
    astrobin.js          fetchImage() — AstroBin API v2 client
  middleware/
    upload.js            multer config with file size limits (#55 fix)
  package.json           (unchanged)
  config.json            (unchanged, gitignored)
  REFACTOR-PLAN.md       (this file — delete after refactor)
```

## Execution Order (within a single session)

### Phase 1: Extract shared libraries (no route changes)
1. Create `lib/config.js` — extract `loadConfig()` and `saveConfig()`
   - This already incorporates the #34 fix (merge instead of overwrite)
   - Export: `{ loadConfig, saveConfig, getConfig }`
2. Create `lib/r2.js` — extract S3Client init + upload/delete helpers
   - Depends on config.js for credentials
   - Export: `{ createR2Client, uploadDirectory, deletePrefix }`
3. Create `lib/astap.js` — extract execFile wrapper
   - Include path validation from #52
   - Export: `{ solvePlate }`
4. Create `lib/simbad.js` — extract Simbad HTTP call
   - Export: `{ querySimbad }`
5. Create `lib/astrobin.js` — extract AstroBin API call
   - Export: `{ fetchAstroBinImage }`

### Phase 2: Extract middleware
6. Create `middleware/upload.js` — multer config
   - Include 500MB file size limit (#55)
   - Export: configured multer instance

### Phase 3: Extract routes (one at a time, test after each)
7. Create `routes/settings.js` — simplest route, good smoke test
8. Create `routes/metadata.js` — depends on lib/simbad + lib/astrobin
9. Create `routes/images.js` — depends on lib/config
10. Create `routes/upload.js` — depends on middleware/upload
11. Create `routes/platesolve.js` — depends on lib/astap
12. Create `routes/tiles.js` — depends on lib/r2 + lib/config (most complex)

### Phase 4: Slim down server.js
13. Replace server.js body with imports + Express app setup + route mounting
14. Verify `npm start` works end-to-end

## Testing Strategy
- After each phase, run `node server.js` and verify the web UI loads
- After each route extraction, test that specific API endpoint via the UI
- No automated tests exist yet — this refactor makes adding them feasible

## Dependencies
These fixes should be applied BEFORE or DURING the refactor (not separately):
- #34 (settings wipe) → ✅ DONE (merged config spread)
- #35 (0.0.0.0 bind) → ✅ DONE (127.0.0.1)
- #55 (multer limits) → ✅ DONE (500MB limit)
- #36 (multer upgrade) → migrate to multer 2.x during refactor
  (1.4.5-lts.2 has 0 npm audit vulns; 2.x is a breaking API change)

## Risk Mitigation
- Git commit after each phase (4 commits total)
- If session compacts mid-refactor, the plan in this file + git history
  provides enough context to resume
