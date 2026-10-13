# Human-controlled login and recovery

The `/login` page is a controlled credential test, not an access gate or a production account system. Investigation remains accessible after a rejected login. Every login and retry requires the person to enter and submit a username and password. BizPlus and the independent observer never fill or submit these credentials.

The public synthetic demo account is username `owner` and password `BizPlus@123`. These are demonstration values, not a private account. Backend `DEMO_LOGIN_USERNAME` and `DEMO_LOGIN_PASSWORD` can select another controlled account; configured values are omitted from `/api/login/config`.

## Demonstrate rejection and recovery

1. Open Login, enter a wrong credential pair, and submit. The server returns HTTP 401 and the form displays **Invalid username or password**.
2. Open the linked Investigation incident. Its evidence contains the rejected response and failed assertion, with submitted credentials excluded.
3. Choose **Enter correct credentials**. A wrong retry keeps the incident open.
4. Enter the correct pair yourself. The server verifies it, displays **Login successful**, and resolves only that session's original incident. The original failed execution stays failed in history, alongside the manual verification.

A successful unrelated login does not resolve an earlier incident. A later wrong submission against an already resolved incident creates a fresh rejection instead of altering the verified incident.

## Live tests

Select **Login rejected**. A form with only Username and Password appears in the Live tests page. **Open manual login test** also prepares an isolated website with the same two fields. It does not automatically attempt or reject a login.

Submit wrong credentials to create an Investigation incident with `live_test` as its source. Submit corrected credentials yourself to verify recovery and show a simple **Login successful** dashboard. Restoring the test page or allowing its fault to expire cannot resolve a rejected-login incident.

A live page check can report that the form is reachable, but it explicitly does not establish successful authentication. The observer stops at credential forms and never fills or submits them. Generic live recovery cannot use form availability to verify an earlier failed browser interaction.

## Local preview

Run from the repository root:

```powershell
$env:SERVE_FRONTEND = 'true'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:3024'
npm.cmd run build:backend
node scripts/local-login-fixture.mjs
```

Open `http://127.0.0.1:3024/login`. This loopback presentation instance uses its own `.local/manual-login-demo.sqlite` and does not replace existing application processes or databases.

## Verification

The backend suite covers rejection, session ownership, correct and incorrect manual recovery, idempotency, preserved failure evidence, metrics, and restart persistence. The observer suite verifies that a credential page causes zero input fills and zero login submissions. `node scripts/verify-manual-login-browser.mjs` runs synthetic browser fixtures through the complete login, Investigation, recovery, Live tests and mobile flows. Its saved report and screenshots exclude entered credentials.
