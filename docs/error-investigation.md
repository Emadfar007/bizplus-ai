# Errors in Investigation

The same Investigation history now includes failed API requests, browser exceptions,
unhandled promise rejections, failed page resources, invalid form or cart input,
checkout loading and payment failures, live checks, and independent observer checks.
HTTP 200 does not hide a failed content or business assertion. Existing sandbox
workflow failures and manual login incidents retain their original evidence and
recovery flows.

The application records fixed error categories, normalized route templates, HTTP
status when available, timestamps, and related check IDs. Error reports never include
credentials, request bodies, raw exception text, payment signatures, or raw provider
messages. Repeated open failures group into one incident with bounded evidence and
an occurrence count. Browser reports use UUIDs for retry idempotence and a separate
reporting rate budget, so they do not consume the human's login or checkout budget.

Investigation refreshes when a browser report is saved. If error reporting is
unavailable, safe device reports remain visible in Investigation and are retried
when the API or network returns. The queue belongs to the original session and is
bounded to 40 reports retained for at most 24 hours. Creating a fresh demo session
does not transfer its previous queued errors. Repeated browser errors within
30 seconds coalesce before transmission; browser sends are bounded to eight per
minute. Server incidents also group repeat observations.
Identical API failures within five seconds share a capture, and server capture
budgets bound reporting work even for traffic rejected by normal API rate limits.

Live and observer errors link back to their actual checks. Only a fresh passing
check for the same target can verify a live repair; matching newer observer checks
verify observer outcomes. The original failed run stays failed. Login attempts are
never entered or retried by the AI or observer. Only successful credentials submitted
by the human can resolve a login rejection. Generic browser, API, or payment errors
provide review guidance instead of claiming an automatic repair. Closing a payment
modal is a normal notice and does not create an error incident.

Journey success and duration statistics continue to measure actual workflow runs.
Application error events remain in recent history and the all-source incident count.
Verified live and observer repairs count as recoveries; their untimed verification
events do not dilute the measured duration of receipt or manual login recovery.

The browser can report errors only after its reporting code has loaded. A complete
browser or process crash cannot be recorded by that same process; the independent
observer detects externally visible outages. While the backend is down, device
reports cannot be saved server-side until it returns. Current Render history uses
temporary SQLite and resets when the hosted service restarts.

Validation includes backend reporter and HTTP integration tests, live/observer
bridge tests, and `scripts/verify-investigation-browser.mjs`. Browser QA uses real
synthetic incidents and deliberate fault-lab failures. Its checkout callback check
uses a controlled browser provider fixture and submits no payment.
