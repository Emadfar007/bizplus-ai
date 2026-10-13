# BizPlus independent observer

This separate Node 24 service checks a fixed `BIZPLUS_ORIGIN` even while the BizPlus application is offline. Its own `/health` reports observer health separately from monitored website checks. SQLite retains bounded check history and opens/resolves incidents after observed failure/recovery.

```
npm ci
npm run install:browser
npm start
```

Set `BIZPLUS_ORIGIN` to the owned BizPlus HTTPS origin and `OBSERVER_TOKEN` to a random server-only secret. Production startup requires this token. The main backend sends this secret as `X-Observer-Token`; it must never be included in frontend environment variables. Local loopback origins additionally require `OBSERVER_ALLOW_LOCAL=true`.

HTTP availability, database readiness, and the storefront document are inspected every 30 seconds. Every five minutes Chromium operates the real storefront's add, increase, and decrease controls in a fresh browser cart, verifies configured checkout availability, and closes without opening the provider. A dedicated synthetic API session then checks login, inventory, cart, synthetic payment, and confirmation; it never creates a provider payment. Browser resources are required: unavailable Chromium is a monitor error, never a passing website result.

`GET /` displays the independent read-only dashboard and refreshes latest checks, explanations, and incidents every five seconds. It remains usable while the main app is down. `GET /api/status` returns latest checks, incidents, observer instance identity, history policy, and limitations. `POST /api/browser-probe` accepts only `{ "sessionId": "UUID" }` and visits the fixed `/test-site/UUID` HTML lab through actual login, add-product, and confirmation controls. `POST /api/check` requests a bounded immediate independent check cycle. Mutations require `X-Observer-Token` when configured. No API accepts arbitrary target URLs or arbitrary browser scripts. Browser requests are restricted to the configured origin and GET/HEAD methods.

Deploy `observer/Dockerfile` with build context `observer/`, `PORT` supplied by hosting, and health path `/health`. The image installs the pinned Playwright Chromium runtime. Render free web services can sleep and use temporary disk: this gives outage separation, not a durable uninterrupted 24/7 guarantee. Always-on hosting with persistent storage is required for that guarantee. This instance retains up to seven days/1,000 checks. A new host instance may reset temporary history; instance identity makes that visible.

Symptom reports distinguish observed contract failures from unconfirmed production causes. Logs, traces, and dependency evidence are still needed to prove a production root cause. The browser test checks only the implemented shop journey; the provider and arbitrary authenticated sites are outside its coverage.

The Docker browser installation follows [Playwright's official Docker guidance](https://playwright.dev/docs/docker).
