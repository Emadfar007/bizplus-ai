# BizPlus AI verification results

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

Public deployment, the hosted cold-start experience, and a second-device check remain pending. Deployment configuration and exact hosting steps are included in the README.
