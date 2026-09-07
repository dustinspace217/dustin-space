## Status (updated 2026-09-07)
Phase: 2 of 2 (MeLe deployed; GitHub delivery in progress)
Done: isolated tests and lint; MeLe backup, single-file update, and restart verified
Next: publish and merge the narrow release after GitHub checks
Blocked: nothing

# Publishing safeguards delivery

Dustin authorized deploying the live-publisher and ingest safeguards. This release contains only their seven implementation/test files; the other local review repairs remain outside this release. Baseline is `076f2c1e902edd4c4b88924094afe8d0f42dd709`.

The publisher excludes the current JPEG key from both stale-cleanup sources, including a key queued after a failed status upload. It still removes older captures. Ingest namespaces revisions by parent variant, rejects destination collisions, and verifies that its metadata commit includes the referenced assets. Its commit excludes unrelated staged work, and network push happens outside the local gallery mutex.

The earlier independent review and cross-examination are recorded in [Dev Sessions #155](https://github.com/dustinspace217/dustin-space/discussions/155). A separate delivery check confirmed this subset depends only on code already present in the baseline; no dependency or schema changes are needed. The existing limitation remains: simultaneous uploads to the same R2 prefix can race before local metadata is committed.

Verification was run in an isolated checkout containing just this release: all 236 Node tests pass, including the production build check; the focused publisher/ingest run passes 37 tests; publisher ESLint and whitespace checks pass. Image generation, R2 writes, and network pushes are faked in the regression tests; real Git operations use disposable repositories.

## Deployment procedure

Read the actual Scheduled Task and deployed file hashes first. Preserve config, deduplication state, resolver cache, task registration, and dependencies. During a quiet interval, stop the existing `dustin.space now-imaging` task, verify its process has exited, back up its code and state, replace only `lib/publish.js`, verify its hash, and start the same task. Confirm a new process and post-start log. The normal dry-run mode shares production state, so it is unsuitable for an installation smoke test.

The ingest tool runs from the main checkout. If it is running, wait for jobs to finish and restart it to load the new pipeline. If it is stopped, its next normal launch loads the updated files. No real ingest upload is needed to verify the regression cases.

## Deviations

- Scope: this is a narrow delivery of the two publishing safeguards Dustin approved. The broader page and Descent repairs remain local for a separate delivery.
- Transport: GitHub SSH authentication failed; the existing authenticated `gh` credential helper will be used with HTTPS for this release, without changing the repository's remote configuration.

## Delivery evidence

The MeLe update completed at 2026-09-07 14:52:21 UTC. The previous publisher process (8904) exited; the same Scheduled Task started process 8092. Fresh logs show startup at 14:52:19.991 UTC, the IMAGE-SAVE subscription at 14:52:20.034 UTC, and a successful empty-history check at 14:52:20.042 UTC. NINA's history was empty and its camera was not exposing before the stop.

Installed `lib/publish.js` SHA-256: `e8f96bd045234be4b6dbcec42dfd0be1e54740b10e055b135ffcf92dc2175515`. The original module is backed up under `C:\Users\Pro 13\now-imaging\backups\publishing-safeguards-20260907T145216Z\publish.js`. Static installation/config hashes and the state/cache snapshot taken after process exit were unchanged by replacement. Task registration and dependencies were preserved.

The local process check found no ingest server running. Its next normal launch from the main checkout loads the corrected pipeline. GitHub delivery checks are pending. First real LIGHT publication and browser/CORS acceptance remain tied to an imaging session; the verified restart and isolated tests do not claim those operational checks are complete.
