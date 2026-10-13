# BizPlus AI verification results

## Live incident release — 13 October 2026

Live checks now include rules-based failure explanations, observed facts, confirmed versus possible causes, suggested solutions, preserved incident evidence, and fresh recovery verification. The fault lab is session-isolated, expires after at most two minutes, and affects only the dedicated synthetic test website.

| Scope | Observed result |
| --- | --- |
| Complete backend suite | **47/47 passed**, including actual local PostgreSQL |
| Independent observer suite | **11/11 passed**, including actual Chromium |
| TypeScript and production build | Passed; the exact publication tree also built successfully |
| Local controlled failures | **11/11** detected, explained, restored and verified |
| Public controlled failures | **11/11** detected, explained, restored and verified through real HTTPS and the separately hosted Chromium observer |
| Real request timeout | Delayed response exceeded the actual twelve-second deadline; recovery passed |
| Local browser UI | Healthy → HTTP 500 → verified recovery; HTTP 200 JavaScript failure → verified recovery; original failures retained |
| Mobile UI | 390-pixel layout had no document overflow or application page errors |
| Independent OS-process outage test | Dedicated target process stopped; observer stayed available, opened an outage incident, and verified recovery after target restart |
| Public dependency readiness | Primary database reads and actual read-only Razorpay Test Mode authentication passed |
| Public observer | Availability, readiness, storefront document, real storefront cart controls, and synthetic login-to-confirmation journey passed |

Evidence: [public fault replay](../artifacts/verification/render-live-errors.json), [local fault replay](../artifacts/verification/live-errors-local.json), [local browser workflow](../artifacts/verification/live-errors-browser-local.json), and [separate-process outage proof](../artifacts/verification/observer-process-outage-local.json). The independent monitor is [bizplus-ai-observer.onrender.com](https://bizplus-ai-observer.onrender.com).

The public observer also recorded a transient hosted application interruption during deployment and resolved the affected availability/readiness/storefront incidents after passing checks. That observation alone does not establish the hosting failure's underlying cause. The browser runner now retains bounded, sanitized action errors and permits initial storefront hydration within its overall fifteen-second budget.

All fault operations were isolated; no real database outage or provider payment was introduced. Restoring a test site clears only the matching session fault and resolves the incident only after a new passing check. Browser incidents cannot resolve through HTTP-only verification when the browser monitor is unavailable. Public lab requests are rate- and concurrency-bounded; unknown UUIDs cannot allocate test sessions.

The observer runs in a separate free Render service, so its process is independent of the monitored application. Free instances can sleep and hosted SQLite history remains temporary. Uninterrupted production monitoring requires an always-on host and durable storage. Unattended storefront checks cover cart controls and checkout availability; they do not submit real payment checkout or arbitrary customer authentication. See [live errors and controlled recovery](live-errors.md).

## Current commerce release — 13 October 2026

The complete frontend and API are live on [Render](https://bizplus-ai-api.onrender.com). Monitoring scenarios, storefront purchases, and live website checks use separate records and metrics.

| Scope | Observed result |
| --- | --- |
| Expanded local automated suite | **33/33 passed** |
| TypeScript checking and production builds | Passed |
| Latest public synthetic-workflow smoke replay | **18/18 passed** |
| Render frontend routes | `/`, `/shop`, `/live-tests`, and `/incidents` returned the React application |
| Public Razorpay Test Mode checkout | ₹599 Orbit Mini Speaker; captured payment; original order paid; server-verified receipt |
| Public receipt refresh | Paid receipt retained and cart empty |
| Public recovery journey | Missing confirmation → evidence → approved worker resume → verified; original order retained; payments **1 → 1** |
| Public browser-triggered live HTTPS check | HTTP 200, expected content found, 181 bytes, **79 ms** |
| Local PostgreSQL integration | Actual PostgreSQL instance, restart persistence, strict TLS configuration, repeatable migration tested |
| Hosted primary store | Temporary SQLite; Supabase connection pending |
| Explicit local fallback | `npm run start:local` returned healthy, local history, SQLite even with cloud configuration present |

Evidence: [current hosted workflow replay](../artifacts/verification/hosted-commerce-release.json), [public recovery browser journey](../artifacts/verification/render-recovery-browser.json), [public Razorpay purchase](../artifacts/verification/razorpay-render-purchase.json), [public live check](../artifacts/verification/render-live-browser.json), and [local PostgreSQL verification](../artifacts/verification/postgres-local.json). Actual public screenshots are [recovery](../artifacts/screenshots/render-recovery-verified.jpg), [storefront](../artifacts/screenshots/render-shop-paid.jpg), and [live tests](../artifacts/screenshots/render-live-tests.jpg).

The latest hosted replay at 12:32 IST measured healthy execution **1834 ms**, checkout 500 **950 ms**, missing confirmation **1203 ms**, and recovery verification **237 ms**, preserving the original order and one payment. These are individual sandbox samples with a deliberate 220 ms delay per request; they are not production benchmarks. The 33-test suite ran locally, while 18 public smoke checks cover the synthetic core.

The public browser completed Razorpay **Test Mode** checkout, then the server checked the signature and provider records. Independent provider read-back confirmed captured payment, matching original order, exact INR amount, paid totals, and zero amount due. Refresh retained the server-verified receipt. No real funds moved and products are not shipped. A separate [local Test Mode purchase](../artifacts/verification/razorpay-test-purchase.json) is preserved as earlier evidence.

The live-test UI made an actual HTTPS request to the owned Render `/health` target and showed all three passing assertions. The initial cold-start request recorded HTTP 503, followed by passing checks. Neither sample establishes guaranteed wake time or latency. See [cold-start evidence](../artifacts/verification/live-website-cold-start.json).

Expanded automated coverage includes payment tampering, signature checks, duplicate callbacks, checkout-key idempotency, delayed capture reconciliation, bounded live requests, allowlisted targets, DNS restrictions, transient persistence failures, private PostgreSQL storage, safe recovery, session ownership, and static hosting boundaries. Desktop and 390 by 844 layouts were inspected without document overflow. Physical second-device, incognito, and mobile-network tests have not been performed.

The Supabase `DATABASE_URL` on disk still begins with **HTTPS**. This is a project API address, not a PostgreSQL connection URI. No cloud migration was performed and no unrelated Supabase project was modified. A valid `postgresql://` Session pooler connection is required before cloud configuration and migration can proceed. The private schema and repeatable migration are implemented and locally verified.

Hosted SQLite records may reset on restart or redeployment. Screenshots preserve observed evidence, not durable hosted storage. The local sandbox fallback works after dependency installation; Razorpay and public website checks require internet.

## Historical MVP verification

Recorded **13 October 2026, 10:27 IST** against the local production backend and actual HTTP requests to the owned sandbox. The raw replay is [local-replay.json](../artifacts/verification/local-replay.json).

## Measured replay

| Check | Observed result |
| --- | --- |
| Automated backend integration tests | 11 of 11 passed |
| Healthy workflow | Passed, 1221 ms |
| Checkout HTTP 500 | Failed at checkout before payment, 1005 ms |
| Missing confirmation | HTTP 200 with a missing-order assertion failure, 1180 ms |
| Approved recovery | Verified, 247 ms |
| Payment count before and after recovery | 1 and 1 |
| Original order preserved | Yes |
| Repeated recovery request | Returned the same recovery ID |

The sandbox includes a deliberate 220 ms request delay so the demo's progression is visible. These timings describe one local replay and are not production performance benchmarks.

The original failed run remains failed after successful recovery. Dashboard success rate measures workflow executions; verified recoveries are counted separately.

## Automated coverage

The integration suite verifies healthy actual HTTP execution, checkout failure before writes, HTTP 200 business-outcome failure, idempotent recovery, explicit approval and action restrictions, session ownership, failed verification remaining open, independent sessions with one active run each, timeout evidence, bounded request rates, metrics derived from all records, and safe restart handling for interrupted runs and recoveries.

## Release status

The local browser completed the healthy workflow, checkout 500, missing confirmation despite HTTP 200, and approved recovery with a verified comparison. Unified TypeScript checking and the production build passed. Actual desktop captures appear in `artifacts/screenshots`.

Responsive checks passed at 1440 by 900 and 390 by 844 pixels. The mobile page had no document overflow, and its navigation worked. Direct recovery-route refresh retained the original evidence and resolved incident. Starting a fresh session cleared its visible history without deleting previous session records.

Stopping the owned local API produced the backend-offline message and disabled Run Test. Restarting the API restored backend readiness and usable test controls. Physical-phone, incognito-hosted, and mobile-network checks have not been performed.

## Hosted backend verification

The free Render backend is deployed at [bizplus-ai-api.onrender.com](https://bizplus-ai-api.onrender.com/health). On **13 October 2026, 11:18 IST**, a separate public HTTP smoke replay passed **18 of 18 checks**. Its actual responses are saved in [hosted-api-replay.json](../artifacts/verification/hosted-api-replay.json). The eleven-case integration suite above ran locally; it was not rerun on Render.

| Hosted check | Observed result |
| --- | --- |
| Healthy execution | Passed, 1556 ms |
| Checkout HTTP 500 | 951 ms; zero payments; confirmation skipped |
| Missing confirmation | 1239 ms; HTTP 200 failed its business assertion |
| Recovery verification | 238 ms; same original order; payments 1 to 1 |
| Fingerprint grouping | Two recurring missing-confirmation incidents grouped |
| Approval and isolation | Unapproved action rejected; unrelated session reads returned 404 |
| Repeated recovery | Same recovery ID returned |

These are one hosted sandbox sample, including the deliberate 220 ms delay per request. Execution timings exclude browser/network round trips. Recovery's measured public round trip was 305 ms.

This initial release preceded the complete Render frontend deployment documented above. The connector-created service uses Render's default TCP health check; the intended `/health` path can be set in service settings and is already specified in the Blueprint. Deployment configuration and exact hosting steps are included in the README.
