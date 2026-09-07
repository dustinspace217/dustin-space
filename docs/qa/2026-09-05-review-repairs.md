# Review repairs — QA record

## Publisher and ingest delivery — complete 2026-09-07

PR #160 delivered the reviewed publishing safeguards as merge commit `3e6601a8a5f64f9ce23c15469a7dd212e2605607`. MeLe backup/update/restart, follow-up heartbeat, isolated subset tests, GitHub CI and production Cloudflare deployment all passed. Other local review repairs remain uncommitted. See [the delivery receipt](2026-09-07-publishing-receipt.md) for evidence, preserved-working-tree checks and the GitHub SSH authentication follow-up. This supersedes the earlier all-local publication status below.

## Live HSTS confirmation — complete 2026-09-07 14:03 UTC

Final state: Dustin turned Preload off, with Cloudflare recording the change at `2026-09-07T14:01:59.702390Z`. API reads confirm `enabled=true`, `max_age=15552000`, `include_subdomains=true`, `preload=false`. Fresh public probes at `2026-09-07T14:03:01.970625Z` show `max-age=15552000; includeSubDomains` on all five active hosts. Certificate validation and HTTP-to-HTTPS redirects still pass. The live HSTS issue is resolved.

After Dustin reported saving the setting, authenticated Cloudflare reads report `enabled=true`, `max_age=15552000`, `include_subdomains=true`, `preload=true`, `nosniff=false`; modified at `2026-09-07T14:00:08.568342Z`. Public TLS/HTTP probes starting at `2026-09-07T14:01:07.934831Z` confirmed `max-age=15552000; includeSubDomains; preload` on apex, www, tiles, live, and skyglance. All certificates still validate, HTTP still redirects to HTTPS, and application statuses remain the expected 200/404/401 described below.

HSTS is now active. Cloudflare's six-month choice produces 180 days, while the existing source requests 182.5 days; the earlier exact prediction of 15768000 for the dashboard selection was inaccurate. This small positive-duration difference is not the original HSTS-disable defect. Preload was enabled too, contrary to the intended setting: turn only Preload off, retaining Max Age and includeSubDomains, then verify the effective response. A preload directive is not proof of enrollment in a browser's built-in list. [Official submission requirements](https://hstspreload.org/#submission-requirements) require at least a year for new enrollment.

This follow-up supersedes the earlier pending-enablement snapshots below. Cloudflare was changed by Dustin; no API mutation was performed by the agent. The project repairs still remain local and uncommitted.

## HSTS diagnosis follow-up — 2026-09-07

Dustin saved a zone-scoped read token after the existing Wrangler OAuth returned 403. The new token successfully read `settings/security_header`: `strict_transport_security` is `{ "enabled": true, "max_age": 0, "include_subdomains": true, "preload": false, "nosniff": false }`. Cloudflare reports this setting was last modified at `2026-04-21T01:22:19.088494Z`; that timestamp does not identify who changed it or why.

The zone has no entrypoint ruleset for `http_response_headers_transform` or `http_config_settings` (authenticated 404, code 10003, explicitly reporting that the entrypoint was not found). A fresh HTTPS HEAD request at `2026-09-07 10:44:54 UTC` returned 200 with `strict-transport-security: max-age=0; includeSubDomains`, matching the zone setting while the source requests `15768000`.

[Cloudflare documents](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/) Max Age Header `0 (Disable)` as disabling the browser's HSTS policy even while its header-sending control is enabled. The smallest correction is to select six months under dustin.space → SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS), retaining enabled/on, includeSubDomains/on, and preload/off. Re-read the setting and the public header afterward; expected `max-age=15768000; includeSubDomains`. No production setting was changed, and no token value was printed or stored in this repository. The diagnosis identifies the conflicting zone setting; post-change verification is still required before declaring HSTS repaired.

Baseline: `076f2c1`. Review covers the approved portfolio repairs, with the storefront excluded. Descent source baseline is `whale-song` at `e9ba15c`. Changes remain local unless a deployment is explicitly recorded below. GitHub artifact: https://github.com/dustinspace217/dustin-space/discussions/155.

## HSTS prerequisite check — 2026-09-07

Dustin requested verification of Cloudflare's HSTS requirements before enabling the six-month policy. Authenticated settings reads confirm the zone is active and not paused, SSL mode is Full (strict) with certificate status active and no validation errors, and Always Use HTTPS is on. After Dustin added certificate-read access, Universal SSL reads enabled; an active universal certificate pack covers the apex and `*.dustin.space`, and an active advanced pack covers the apex, `skyglance.dustin.space`, and `*.skyglance.dustin.space`.

Public probes at `2026-09-07 10:55:28 UTC` used system certificate trust and hostname verification, without bypassing validation. All five known hosts negotiate TLS 1.3 with valid Google Trust Services certificates. Each HTTP root returns 301 to the same HTTPS URL, with no subsequent downgrade:

| Host | HTTPS root | Presented certificate expires (UTC) |
| --- | --- | --- |
| dustin.space | 200 | 2026-11-14 22:30:02 |
| www.dustin.space | 200 | 2026-11-14 21:32:39 |
| tiles.dustin.space | 404 | 2026-10-20 14:53:14 |
| live.dustin.space | 404 | 2026-12-01 19:28:55 |
| skyglance.dustin.space | 401 | 2026-11-29 08:26:06 |

The 404/401 application responses do not indicate certificate failures: the TLS handshake and hostname validation passed before HTTP was received. The storage roots have no index object; Skyglance is a protected Worker. No access key was sent in these probes. Skyglance's custom domain is independently verified in its Worker configuration; it expands the portfolio repository's four-host inventory.

[Cloudflare Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/) is automatically renewed. [R2 custom domains use Cloudflare for SaaS certificates](https://developers.cloudflare.com/r2/reference/data-security/); [Pages also manages custom-domain issuance](https://developers.cloudflare.com/pages/configuration/custom-domains/). Certificate expiry before the HSTS duration is normal with renewal; it is not a requirement to hold one certificate valid for the entire six months. A public, DNSSEC-validated apex CAA query returned NOERROR with no CAA answer, so no apex CAA restriction was observed.

The DNS inventory subsequently succeeded with the same saved token after its permissions were updated and a request using a different query was made; no causal claim is made about the earlier 403s. All 16 records fit on one page. There are 11 A/AAAA/CNAME owner names, all proxied, plus apex MX/TXT records and two SIP SRV records. No wildcard DNS record, child NS delegation, or CAA record appears in the zone inventory. Current CT data lists the apex, www, tiles and a wildcard but omits known live and skyglance hosts, so CT is not a substitute for this inventory.

Additional probes at `2026-09-07 10:59:42 UTC` found:

| Service alias | CNAME target | Public HTTPS observation |
| --- | --- | --- |
| autodiscover.dustin.space | autodiscover.outlook.com | Valid edge certificate; HTTP 521 |
| email.dustin.space | email.secureserver.net | Valid edge certificate; HTTP 526 |
| lyncdiscover.dustin.space | webdir.online.lync.com | Valid edge certificate; HTTP 530 |
| sip.dustin.space | sipdir.online.lync.com | Valid edge certificate; HTTP 530 |
| msoid.dustin.space | clientconfig.microsoftonline-p.net | Valid edge certificate; HTTP 200 |
| _domainconnect.dustin.space | _domainconnect.gd.domaincontrol.com | TLS hostname mismatch when treated as a web endpoint |

The five matching service-alias certificates expire `2026-10-17 03:49:21 UTC`. These application errors predate enabling HSTS; they do not prove that email delivery or client discovery is broken. [Microsoft documents](https://learn.microsoft.com/en-us/microsoft-365/admin/dns/create-dns-records-at-cloudflare?view=o365-worldwide) Autodiscover/SIP discovery records, and [Cloudflare warns](https://developers.cloudflare.com/dns/troubleshooting/email-issues/#is-your-mail-hostname-proxied) that service records needing the provider's real target should be DNS-only. Changing proxy state is not by itself proof of HTTPS hostname compatibility, and no DNS record was changed.

The `_domainconnect` TLS result is not a website failure: [the protocol](https://github.com/Domain-Connect/spec/blob/master/Domain%20Connect%20Spec%20Draft.adoc#dns-provider-discovery) queries TXT through the CNAME and contacts the provider endpoint returned by DNS. Not every DNS label must serve a homepage. HSTS governs HTTP clients, not DNS, MX, SMTP, or SIP.

At `2026-09-07 04:02 PDT`, Dustin confirmed that he no longer uses domain email: "I did at one point but not anymore." He previously configured Microsoft 365 through GoDaddy and does not know whether the mailbox remains usable. The current active site therefore meets the HSTS prerequisites: all five used portfolio/Worker hosts pass HTTPS/certificate checks, managed certificate coverage is active, and redirects upgrade to HTTPS. Recommend six months with includeSubDomains on and preload off for this current use. The unused aliases are not a reason to withhold protection from the active site; preserve their records and validate provider DNS/discovery/login requirements before any reactivation. No mailbox login or delivery test was performed, so neither mailbox existence nor email delivery was established. DNS hosting at Cloudflare does not itself retire a Microsoft 365 account.

No Cloudflare setting changed. The old `_headers` comment inferred a complete inventory from CT; it now points to this fuller check and records the unused-service constraint without changing the configured header value. Post-change public verification is still required before claiming HSTS enabled.

Ongoing operating requirement: keep valid HTTPS for the apex and covered web subdomains. Before changing hosting, proxy state, DNS, or certificate settings, verify the replacement serves valid HTTPS for every affected name. To retire HTTPS instead, serve HSTS max-age zero while HTTPS still works (at every hostname issuing its own HSTS policy), stop renewing positive HSTS policies, and preserve HTTPS for the previously advertised duration so clients that do not revisit can expire their cached policy. Preload remains off. These are future change constraints, not something a one-time probe can guarantee indefinitely.

## Phase A — independent findings

### Code, accessibility and performance

**CR-1 / P2: resizing could hide the focused Home link.** The initial focus repair left an inline `opacity: 0` assignment in the resize handler. In headless Chromium, resizing from 1440 to 1439 pixels and focusing Home left the real link transparent while the focus treatment hid the animated duplicate. Remove that remaining inline assignment; cover resize and mobile rotation in the browser checks. The reviewer found no other actionable defect in its inspected scope.

Verification: fresh build, browser reproduction and focused tests. Root fixed this finding and a related open-menu rotation path that had restored the title transform without restoring the Home link's tab stop. The final browser subset passes all 14 checks.

### Test analysis and state lifetime

**TA-1 / P2: a publish could include another capture's metadata without its images.** The shared `images.json` can contain an earlier local-only ingest or one completed during another job's build validation. A path-limited commit included that JSON plus only the publishing job's WebPs. A real scratch Git reproduction found two targets in committed JSON but no files for the second target. A working-directory build could not catch this: those files existed locally.

Before committing, check the persisted gallery's local asset references against `HEAD` plus the selected paths. Refuse an incomplete set before staging, name the missing files, and preserve all local data. Serialize that check through commit using the existing gallery mutex. A lock alone does not solve an earlier unpublished capture.

Verification: 29 focused regression tests and a deterministic scratch-repository reproduction, with fake image/R2 services and no remote push. State review covered publisher persisted keys and pending deletions, gallery cache/mutex, revision paths, annotation timers, WCS cache and Home animation flags. This reviewer inadvertently saw CR-1 in the plan before inspecting Home; it does not claim independent confirmation of CR-1.

### Security and dependencies

**SD-1 / P2: a stalled push could block all ingest writers.** The first TA-1 remediation held the gallery mutex through `git push`, and the subprocess helper supplied no timeout. A hung network operation would then prevent even a local-only capture from saving. Keep the check, staging and commit serialized; release the mutex before push, and give commands retained under the mutex finite timeouts. Cover stalled push and timeout recovery.

Verification: this finding was established by source tracing. A completed mechanical pass scanned six files with four local Semgrep rules; its 21 filesystem-operation matches were expected placement, cleanup, dry-run and fixture code, with no additional vulnerability established. This was a narrow scan, not comprehensive security coverage. The tracked-diff Gitleaks pass found no leaks. No dependency versions changed; Dependabot gains coverage for the existing now-imaging manifest. No registry/advisory audit was completed.

### Descent addendum

**SD-2 / P1: the portfolio CSP blocked the new calculation worker.** The corrected sampler needs a same-origin module worker, while the portfolio allowed only blob workers. Isolated Chromium reproduced the block under the original policy and successful worker loading with `worker-src 'self' blob:`. Root added the same-origin allowance and a browser regression that applies the actual source CSP to the integrated page.

The independent code/math pass found no additional defect. It compared 676 unrestricted/forbidden completion counts across 139 multiset shapes through length 10 against a separate named-symbol recurrence. Composition and no-repeat constraints held across six cache budgets, five seeds and repeated draws; 28 focused tests passed. Every manifest hash matched, and all prior golden fields for the first five rungs were unchanged. The independent security/state pass ran 22 focused sampler, worker and copy tests and found coherent cache bounds, overflow cleanup, BigInt weighting and worker teardown. Neither review claimed a full independent corpus rederivation.

Author validation: all 113 source tests, ESLint/Stylelint and CSV/page/golden verification passed. The regenerated 25-draw estimate is 0.4267606466 bits; a separate 500-draw diagnostic gives 0.4256766973. Both report zero plain fallback failures and the same two approximate blocks, containing 241 of 1,663 pairs. Their remaining nonuniform sampling bias is disclosed separately from the null spread. The 750,000-entry cap and one-job worker follow measured cost: the cache used 658,323 entries and the full calculation took seconds of CPU work. Desktop/mobile browser runs finished in about six seconds, continued painting, and terminated the worker.

The reviewed source patch has been applied to whale-song, and all eight changed public files were synchronized byte-for-byte into the portfolio. No dependency version changed. Two existing jsdom lint configuration omissions and two unused test bindings were corrected to make the required full lint pass; report paths now resolve relative to the module instead of writing into a hardcoded checkout.

## Phase B — cross-examination

**code/accessibility/performance → test**: Agree with TA-1’s problem and current fix. Restricting Git paths alone could publish another capture’s metadata without its assets because captures share images.json. The guard checks references against HEAD or selected paths, then holds the gallery mutex through commit. Refusal before staging preserves local captures and unrelated work. The tests cover captures saved both before publishing and during validation, plus a writer waiting through commit. This avoids silently expanding publication to include other drafts. Its guarantee covers participating ingest writers; overlapping R2 uploads remain a separate documented limitation.

**code/accessibility/performance → security**: Agree with SD-1 and SD-2 and their fixes. Moving push outside the mutex keeps serialization where JSON and commit membership must agree, while local writers can proceed during network delays. Timeout options reach the subprocess helper; regressions cover stalled push and mutex recovery. Adding 'self' to worker-src permits Descent’s module worker and preserves Aladin’s blob allowance. The browser probe checks computation, disclosure and worker termination under the checked-in CSP. This injects source policy into a local response; it does not verify currently deployed Cloudflare headers.

**test/state-lifetime → code**: Agree with CR-1 and its fix after exposure; no independent discovery claimed. Removing the resize assignment lets CSS preserve visible keyboard focus. Reusing enterNav restores pointer access and the tab stop during open-menu rotation. The tests check both retained focus after resizing and restored interaction after rotation.

**test/state-lifetime → security**: Agree with SD-1 and SD-2 and their fixes. The gallery lock protects the asset check through commit; push can proceed after release. Timeout arguments reach the subprocess helper. Same-origin plus blob workers matches the two actual consumers. The new browser test applies the source CSP and checks worker startup, completed computation and termination. All16 focused ingest tests passed in this re-review: incomplete sets refuse before staging; a writer proceeds during stalled push and after an injected commit timeout. Timeout recovery was simulated, not an OS process-hang experiment.

**security/dependencies → code**: Agree with CR-1’s problem and fix. The current source removes the resize handler’s inline opacity override, so the CSS focus rule can remain effective. Open-menu rotation calls enterNav, restoring tab stop and pointer target along with visual position. Reusing that transition avoids restoring only part of the docked state. This is agreement after Phase A exposure; I did not independently rerun the browser reproduction.

**security/dependencies → test**: Agree with TA-1’s problem and fix. A working-directory build cannot prove the selected commit contains every referenced asset. Persisted references are now checked against HEAD plus selected paths before staging; the mutex protects the checked JSON through commit. Refusal preserves captures and unrelated staging. Releasing before push preserves the guarantee because subsequent working-tree edits do not alter the committed tree. SD-1 and SD-2 remediations are present: finite local Git/push timeouts and worker-src 'self' blob:. I inspected these fixes and tests without rerunning the integrated page.

## Phase C — synthesis

All three seats agree with the reported problems and current fixes after exposure. There was no claim of independent Phase A convergence on these four findings. CR-1, TA-1, SD-1 and SD-2 are fixed in the local working changes; none is deferred. No additional defect emerged during cross-examination.

GitHub verification confirmed exactly two threaded Phase B replies on each of the three Phase A comments. Tracking issues [#156](https://github.com/dustinspace217/dustin-space/issues/156), [#157](https://github.com/dustinspace217/dustin-space/issues/157), [#158](https://github.com/dustinspace217/dustin-space/issues/158) and [#159](https://github.com/dustinspace217/dustin-space/issues/159) record CR-1, TA-1, SD-1 and SD-2 respectively. They remain open pending commit/deployment. Source status documents were then updated to record completed review and synchronization; the reviewed program bytes are unchanged.

Final local verification: 239 portfolio tests, 15 browser checks, 113 source-project tests, source ESLint/Stylelint, publisher ESLint, CSV/page/golden verification, and whitespace checks pass. Gitleaks scanned all reviewed changed/new text in both projects (about 822 KB), with no leaks found. Applied source hashes match the reviewed manifest, and all eight public files match their portfolio copies byte-for-byte. The full integrated Descent computation succeeds under the checked-in CSP injected into a local HTTP response; live Cloudflare deployment remains unverified.

Scope additions were driven by reproduced failures: fuller asset-completeness checking after the partial-commit reproduction; shorter mutex lifetime after the stalled-push finding; a worker after measured multi-second computation; same-origin CSP permission after a browser reproduction. Source tooling also needed module-relative report paths and narrow pre-existing lint corrections. These preserve the approved purpose without changing the first five Descent rungs, dependencies, storefront or existing visual design.

## Verification limits

No real R2 uploads, rig actions, production deployment or storefront changes. Local R2 collision checks protect already-published names; simultaneous overlapping uploads remain outside the local gallery mutex. The real Aladin browser check displayed the rotated Pleiades footprint entirely within the initial view; the CI geometry check stubs the external Aladin loader. Existing astronomical metadata was reused, not recalibrated.

HSTS: resolved on September 7 by Dustin's dashboard changes. Authenticated API reads and five-host public probes confirm a 180-day policy with includeSubDomains and no preload. See the confirmation and prerequisite checks above. The agent made no Cloudflare API changes.
