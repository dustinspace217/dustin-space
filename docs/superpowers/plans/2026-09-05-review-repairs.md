## Status (updated 2026-09-07)
Phase: 3 of 3 (approved review fixes delivered and production verified)
Done: publisher/ingest, HSTS, SSH, site/Descent release, live browser verification
Next: actual LIGHT publication and replacement acceptance during an imaging session
Blocked: first real LIGHT/browser acceptance needs an imaging session

# Project review repairs

## Intent and approved scope

Dustin approved the review recommendations, except the storefront, which must remain unchanged. Preserve the current visual direction and copy voice. Copy changes should correct inaccurate present-tense rig descriptions, without changing historical capture locations or rewriting descriptions into generic promotional prose.

The live publisher must continue replacing stale captures. The protection applies only to the image referenced by the newly published status. Ingest must publish image assets and their gallery JSON (caption, filters, equipment and acquisition metadata) together, without absorbing unrelated staged files.

## Phase 1 — Smallest sufficient repairs

- Publisher: filter the current JPEG key from the entire cleanup list, including persisted failures. Keep image upload → status upload → stale deletion ordering.
- Ingest: namespace new revision assets by their parent variant; reject collisions with destination assets before writing. Preserve existing URLs. Restrict the Git commit to the ingest-owned paths.
- Objects: cancel transient flash timers and clear fading classes when the visitor explicitly toggles annotations.
- Atlas: reuse the existing WCS image-to-sky projection for the actual image corners. Validate conflicting metadata before changing stored values; preserve an approximate fallback where there is no plate solution.
- Homepage: visible Home-link keyboard focus and a static reduced-motion fallback; use an existing suitable social-preview image.
- Layouts: render the existing page-specific head additions in the real base-layout head, retaining responsive image source selection.
- Guides: exclude its index from the guide collection.
- Maintenance: include now-imaging in Dependabot; diagnose effective HSTS before changing configuration.
- Presentation: hide empty Skywatching categories; narrowly refresh rig copy. Do not edit the storefront.
- Descent: investigate the existing source-project sampler correction, scope-audit the concrete fix, correct and regenerate upstream, then synchronize the deployed copy. Do not merely replace a displayed number.

Current behavior: the independent review reproduced publication and visitor-state defects while the existing automated checks passed. Required behavior: preserve successful workflows and cover the failure/retry sequences that currently corrupt published state. Main risks: deleting the current image, overwriting historical gallery assets, unintentionally publishing other work, divergent preload sources, inaccurate WCS metadata, or introducing sampler bias while claiming it is resolved.

Architect verdict: SHIP for the specific portfolio repairs, with HSTS diagnosis and Descent design assessed separately. No framework replacement, broad projection rewrite, or legacy-URL migration.

## Phase 2 — Verification and independent QA

- Use isolated fake-service tests for publishing; never touch live R2 or the MeLe to reproduce failures.
- Verify failure → retry same frame → deduplication, plus next-frame replacement and stale deletion failure/retry.
- Verify two variants sharing a revision ID retain separate final bytes and metadata references; verify blocked collisions leave existing assets unchanged.
- Verify gallery JSON and intended assets enter the ingest commit while unrelated staged content stays staged.
- Build and run the existing suites under bounded-run; use a headless isolated browser for keyboard/reduced motion, annotation timer interaction, atlas corners, responsive preload and rendered content checks.
- Perform independent code, test/state-lifetime, security/dependency, accessibility and performance review, then cross-examination and synthesis. Available concurrent seats may combine lenses while maintaining independent findings. Record the complete review in this plan and the project's Dev Sessions artifact when tool access permits.
- No new automatic alarms or watchers are planned. Existing collision refusal is a job error, reported on each affected attempt until corrected; legitimate current-key exclusion is ordinary successful cleanup.

## Phase 3 — Finish

Resolve review findings, re-run affected checks, update this status and deviations, and save durable continuity. Report local changes and any live deployment/source-project limitations precisely. A passing local check does not close the pending first real LIGHT publication and real browser/CORS verification from the Currently Imaging plan.

## Deviations and decisions

- Delivery complete: PR #161 merged as `539bb8714badcf8cbf4c907d1f2630a112b578f0`; production CI and Cloudflare passed. Eight live browser checks passed without response interception, including real CSP, Descent desktop/mobile computation and worker lifetime, responsive Home focus/preloads, content cleanup and a visually verified Pleiades footprint. Issues #156–159 are closed. No implementation deviation arose during delivery. The only remaining operational acceptance is a real LIGHT frame and its replacement; NINA history was empty when checked. See [site delivery record](../../qa/2026-09-07-site-delivery.md).
- September 7 site delivery: the remaining functional bytes still match final QA. The authoritative Descent source is committed locally as `4e033eb93a4630bf8ef07255e6e99a0b1fa4943b`; its repository intentionally has no remote. Fresh isolated validation passes 239 site tests, 15 browser checks and the source tests/lint/numerical verifier. No additional code changes were introduced. Production verification will inspect actual Cloudflare CSP without substituting the local header. See [site delivery record](../../qa/2026-09-07-site-delivery.md).
- Configuration follow-up, September 7: the failing Git command environment omitted `SSH_AUTH_SOCK`; the key was already accepted by GitHub and loaded in KDE's running agent. Saved one repository-local `core.sshCommand` selecting that agent's stable socket. Plain push dry run and the real ingest command helper's SSH read/push probes passed with and without the environment variable. The earlier failure did not establish a failure of desktop-launched ingest. No application code, key or global SSH change was needed. See the delivery receipt for verification and undo.
- Scope, September 7 delivery: publisher and ingest safeguards shipped unchanged through PR #160, merged as `3e6601a8a5f64f9ce23c15469a7dd212e2605607`; MeLe updated and restarted with config/state preserved. GitHub and production Cloudflare checks passed. Other review changes remain local and their content/status were preserved during main reconciliation. GitHub SSH authentication failed, so delivery used the existing gh login over HTTPS without changing the remote. See [delivery receipt](../../qa/2026-09-07-publishing-receipt.md) for evidence and the remaining normal-ingest authentication follow-up.
- Scope exclusion, user-directed: storefront recommendations removed entirely.
- Behavioral correction within the approved focus fix: independent QA found the resize handler's remaining inline opacity assignment. Removed it and added resize/rotation probes. Reading that path also found that open-menu rotation restored only the title transform, leaving the Home link disabled; it now reuses ordinary docking to restore transform, hit target and tab stop together.
- Behavioral correction within head integration: the relocated homepage preloads used a 769px split while the CSS switches at 768px. Aligned the two at exactly 768px, including fractional widths. No image assets changed.
- Implementation detail: two small head partials retain the existing markup; the image head resolves the primary rendition independently of the body. Build assertions compare the actual preload and hero source sets/sizes to prevent drift.
- Stored gallery WCS/sky metadata remains unchanged: the atlas now uses the existing solved corners instead of the conflicting approximate sky fields. No new astronomical calibration was performed.
- Behavioral correction within atlas geometry: the rotated solved footprint did not fit the old initial field of view. The atlas now centers on the solved image center and fits its bounds, retaining the prior wider view where sufficient. A real Aladin render and CI geometry check verify this; stored metadata remains unchanged.
- Behavioral correction within publication: a real Git reproduction showed that another local-only capture could enter shared JSON without its assets. Before staging, ingest now checks referenced assets against HEAD plus the selected paths, refuses incomplete sets and names missing files. The existing mutex protects the check through commit. The follow-up security review found that extending it through push could block writers on a network stall; push now runs after release, with finite Git timeouts and recovery tests.
- Scope change justified by measurement: Descent's corrected exact counter took seconds of CPU time. A single short-lived worker preserves interaction while computing. Browser verification found the portfolio CSP also needed same-origin worker permission; it retains the existing blob allowance.
- Other: Descent's report tool used a hardcoded source-checkout path; module-relative paths make regeneration safe in an isolated checkout. Required full lint exposed two jsdom configuration omissions and two unused bindings, fixed mechanically. No dependency version changed.
- Descent sampler limitation retained explicitly: two long blocks still need a valid nonuniform approximation, containing 241 of 1,663 pairs. The page discloses that remaining bias separately from null spread; the fix does not claim an exact null for the full corpus.
- External configuration: HSTS source already requests six months, but the live response returned zero. The original OAuth reads returned 403. On September 7, Dustin's saved read token exposed the zone setting: HSTS enabled, max_age zero, include_subdomains true, preload false. No zone entrypoint exists for response-header Transform Rules or Configuration Rules. Change only Max Age Header from 0 (Disable) to six months in the dashboard, then verify the public response. No Cloudflare setting has been changed by this review.
- Verification scope: Dustin requested a full HSTS prerequisite check. DNS/certificate access and public probes verify valid HTTPS for all five active portfolio/Worker hosts, Full (strict) SSL, Always Use HTTPS, active certificate packs and Universal SSL. The full DNS inventory also exposed unused provider-service aliases with pre-existing errors. Dustin confirmed he no longer uses domain email; preserve those records and review them before any email reactivation. This does not establish whether the old Microsoft 365 mailbox still exists. Active-site readiness is cleared; only explanatory `_headers` comments changed during this check.
- Live configuration follow-up: Dustin enabled HSTS on September 7 at 14:00:08 UTC. The API and public probes agree on `max-age=15552000; includeSubDomains; preload` across all five active hosts. Cloudflare's six-month selection is 180 days, slightly shorter than the source's 182.5-day constant; that difference does not disable HSTS. The Preload toggle was also enabled, contrary to the agreed recommendation. Request that it be turned off while retaining the age and subdomain policy; a header flag is not proof of browser preload-list enrollment.
- HSTS closure: Dustin turned Preload off at 14:01:59 UTC. The API and fresh public probes at 14:03 UTC confirm `max-age=15552000; includeSubDomains` on all five active hosts, with certificates and redirects still passing. The live HSTS defect is resolved; no Cloudflare API write was performed by the agent.

## QA synthesis

Complete Phase A/B/C record: [QA report](../../qa/2026-09-05-review-repairs.md) and [Dev Sessions #155](https://github.com/dustinspace217/dustin-space/discussions/155). Four actionable findings (Home resize focus, incomplete asset commit, mutex lifetime, worker CSP) were fixed; the three reviewers agreed with their fixes after cross-examination. Independent Descent math checks found no additional defect.

September 5 checks: 239 portfolio tests, 15 browser checks, 113 source tests, source/publisher lint, CSV/page/golden verification, source-manifest hashes and public-copy equality, whitespace checks and changed/new-file secret scan pass. The fresh seeded Descent result is 0.4267606466 bits; a separate 500-draw check yields 0.4256766973, with the same two approximate blocks and zero plain failures. First five rungs remain unchanged. At that checkpoint no production deployment, live R2 upload, rig action, project commit or push had occurred. Source changes were applied to whale-song through explicit filesystem approval before synchronizing public files. The September 7 publisher/ingest delivery is recorded above; the broader repair suite has not been rerun because its code was preserved unchanged.
