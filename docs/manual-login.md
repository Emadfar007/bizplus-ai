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

Double-click the **BizPlus AI** desktop shortcut, or `Start BizPlus AI.vbs` in the repository root. The launcher starts the engine hidden when needed, waits for the API and login page to be ready, then opens `http://127.0.0.1:3024/login` in your default browser. Opening it again reuses the running engine. Closing the browser leaves the engine running; no Windows login startup task or service is installed.

Typing the local URL in a browser cannot start a stopped engine. Use the shortcut to start it. From PowerShell in the repository root, `npm.cmd run start:app` performs the same launch.

Node.js 24, installed dependencies, and a frontend built for port 3024 are required. For initial setup or when the launcher reports missing or incompatible build output, run:

```powershell
npm.cmd ci
$env:SERVE_FRONTEND = 'true'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:3024'
npm.cmd run build:backend
npm.cmd run start:app
```

This loopback presentation instance uses its own `.local/manual-login-demo.sqlite`. The launcher validates prerequisites and reports a conflicting port without stopping another application.

## Verification

The backend suite covers rejection, session ownership, correct and incorrect manual recovery, idempotency, preserved failure evidence, metrics, and restart persistence. The observer suite verifies that a credential page causes zero input fills and zero login submissions. `node scripts/verify-manual-login-browser.mjs` runs synthetic browser fixtures through the complete login, Investigation, recovery, Live tests and mobile flows. Its saved report and screenshots exclude entered credentials.
