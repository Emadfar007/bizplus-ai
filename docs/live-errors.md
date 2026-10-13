# Live errors, investigations and controlled recovery

Open `/live-tests`, choose **Isolated website fault lab**, select an error and introduce it. The application immediately checks the session-specific test URL. Inspect the original failed assertions, captured response, browser evidence, confirmed cause and solutions. Choose **Restore test site and verify**. Resolution requires a new passing check; the original failure remains in history.

Faults affect only `/test-site/<session UUID>` and its synthetic APIs. They expire after at most 120 seconds. They never change the real storefront, database, payment credentials or liveness endpoint. Browser sessions are isolated and all lab confirmations record zero real payments. Existing session IDs provide demo isolation, not production authentication.

| Controlled fault | Evidence used for detection | Verification after restoration |
| --- | --- | --- |
| HTTP 500 / 503 | Real HTTP status and isolated fault log | Expected HTTP 200, required content, non-empty response and browser assertions |
| Missing route | HTTP 404 instead of 200 | Route responds successfully |
| Missing content | HTTP 200 with failed expected-content assertion | Required text found |
| Empty response | HTTP 200 with zero response bytes | Body is present |
| Timeout | Real response delayed beyond the 12-second request deadline | Request completes within its deadline |
| JavaScript initialization error | Browser page error and failed user actions | Page loads and browser journey completes |
| Broken button | Actual browser click produces no expected state change | Sign-in, cart and confirmation assertions pass |
| Login rejection | Synthetic login returns HTTP 401 | Test account signs in |
| Confirmation unavailable | Synthetic confirmation API returns HTTP 503 | Original synthetic journey gets confirmation |
| Catalog dependency unavailable | Synthetic catalog returns HTTP 503 | Product is added to the cart |

For an external owned target, the monitor identifies HTTP, content, network, DNS, TLS, redirect and deadline failures from available evidence. The diagnosis separates observed facts from possible causes. A response alone cannot prove which internal code or dependency failed. Generic HTTP 500 reasons stay unconfirmed. Follow the proposed investigation steps, repair the owned service, then use **Verify after repair**. The monitor only replays configured GET requests; it does not execute arbitrary repair commands.

## Checks beyond liveness

`/health` reports process liveness. `/ready` performs actual reads of the primary order and monitoring tables and authenticates a read-only Razorpay Test Mode request. It reports HTTP 503 if a dependency check fails. Readiness is cached for 60 seconds to bound dependency requests; no order or payment is created. Public readiness responses exclude provider payloads, credentials and internal exception messages.

The separate observer checks liveness, readiness and storefront delivery every 30 seconds. It also runs an actual browser storefront journey and the existing synthetic business workflow every five minutes. Browser checks validate loading, adding a product, cart state and checkout availability. Synthetic workflow checks validate login through order confirmation. The actual Razorpay payment modal, customer authentication and real payment settlement are outside unattended browser coverage.

## Independent observer

The `observer/` service runs in a separate process and can be deployed separately from the main API. Its background loop continues without the Live tests tab. Its own dashboard and `/api/status` remain accessible when the main API is unavailable. It retains its own incidents, distinguishes monitoring failures from website failures, and resolves an incident after a passing check.

The main API connects with `OBSERVER_URL`, an HTTPS origin, and a backend-only `OBSERVER_TOKEN`. The observer uses the matching token, a fixed `BIZPLUS_ORIGIN`, and a real Chromium browser. Browser checks accept a lab session UUID, never an arbitrary URL. Local loopback testing requires an explicit `OBSERVER_ALLOW_LOCAL=true` setting.

Run locally in two terminals:

```powershell
cd observer
npm.cmd ci
npm.cmd run install:browser
$env:BIZPLUS_ORIGIN = 'http://127.0.0.1:3012'
$env:OBSERVER_ALLOW_LOCAL = 'true'
$env:PORT = '3013'
npm.cmd start
```

```powershell
$env:PORT = '3012'
$env:OBSERVER_URL = 'http://127.0.0.1:3013'
$env:OBSERVER_ALLOW_LOCAL = 'true'
npm.cmd run start:local
```

For deployed monitoring, use the observer Dockerfile so the Chromium binary and system libraries are available. A free Render observer can sleep after 15 minutes without inbound traffic and its local history is temporary. It therefore provides an independent demonstration, not an always-on guarantee. An always-on host and durable storage are needed for unattended production monitoring.

## Verification

After both services are running, run `node scripts/verify-live-errors.mjs`. It introduces all eleven supported failures using real requests, asserts a diagnosis and solution, restores each fault, verifies recovery, checks preserved failure evidence and session isolation, and confirms `/health` remains available. Set `VERIFY_ORIGIN` and `VERIFY_OUTPUT` to verify a deployment and save its observed evidence separately.
