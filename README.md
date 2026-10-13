# BizPlus AI

Business transaction monitoring with evidence and approved recovery.

BizPlus AI tests a small shop through login, inventory, cart, simulated checkout, and order confirmation. It catches the demo's key failure: HTTP 200 returns even though the customer has no order confirmation. An operator can inspect the evidence, approve resuming the paused confirmation worker, and verify the original order without creating another payment.

Source repository: [Emadfar007/bizplus-ai](https://github.com/Emadfar007/bizplus-ai) (private).

The complete frontend and API are live on **Render**: [dashboard](https://bizplus-ai-api.onrender.com), [storefront](https://bizplus-ai-api.onrender.com/shop), and [live tests](https://bizplus-ai-api.onrender.com/live-tests). See [verification results](docs/verification-results.md) for the tested scope and current database limitation.

Workflow payments and customers are synthetic. The storefront uses real Razorpay **Test Mode** checkout without moving money or shipping products. Diagnosis is visibly labelled **Rules-based diagnosis**. No LLM account or API key is required.

Live website failures now include evidence-linked explanations and solutions. The isolated website fault lab supports HTTP errors, missing content, empty responses, real timeouts and browser journey failures, with approved restoration and a passing verification required for resolution. A separate observer checks the app and dependencies without relying on the dashboard tab. See [live errors and controlled recovery](docs/live-errors.md) for the workflow, independent observer, verified scope and hosting limits.

Sandbox requests include a deliberate 220 ms delay so judges can follow the step progression. Measured timings include this delay and are demonstration results, not production benchmarks. Live website checks have no injected delay.

## Storefront, Razorpay and live websites

The **Storefront** at `/shop` has six demo products, quantity controls, a session cart, Razorpay Standard Checkout in Test Mode, saved orders, and verified receipts. The server calculates prices, creates the provider order, checks the callback signature, and confirms the captured payment and matching provider totals before marking an order paid. Unchanged-cart retries reuse the original checkout. A delayed capture can be reconciled by reading the same order; checkout is never repeated for verification.

An actual ₹599 Razorpay Test Mode purchase was completed through the **public Render storefront**, and its paid receipt survived refresh. Provider read-back confirmed capture and the original paid order. No real funds moved and demo products are not shipped. See [public payment evidence](artifacts/verification/razorpay-render-purchase.json) and [integration setup](docs/commerce-and-live-tests.md).

**Live tests** at `/live-tests` send bounded HTTPS GET requests to configured owned websites. The default target is the deployed BizPlus Render `/health` URL. Results retain measured latency, status/content assertions, a short text excerpt, and failure fingerprints. A 30-second toggle runs only while the page is visible. It checks HTTP responses; it does not automate browser logins or payments on third-party stores.

`DATABASE_URL` selects PostgreSQL as the primary store for monitoring, live tests, and shop orders. The private schema, strict TLS, restart persistence, and SQLite migration were tested against an actual local PostgreSQL instance. **The hosted Supabase migration remains pending a valid PostgreSQL connection string.** See [database setup and migration](backend/database.md). The current local presentation explicitly uses SQLite until this setting is corrected.

## Run locally on Windows

Install Node.js 24, then open PowerShell in the repository root. The project pins Node 24.19.0 and uses its built-in SQLite API.

```powershell
npm.cmd ci
Copy-Item -LiteralPath frontend/.env.example -Destination frontend/.env.local
npm.cmd run dev
```

Open the Vite URL printed in the terminal, normally `http://localhost:5173`. The API uses `http://localhost:3001` and `/health` returns readiness. Run commands from the repository root so the shared workspace builds first.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

For the presentation fallback, install and build ahead of time. Start the API with `npm.cmd run start:local`, which explicitly uses `backend/data/bizplus.sqlite` even when a cloud connection is configured. In another PowerShell terminal run `npm.cmd run preview -w @bizplus/frontend -- --host 0.0.0.0`. Use the printed preview URL. If its port differs from the configured local CORS origin, set `CORS_ORIGIN` to that exact URL before starting the API. After installation, the sandbox demo needs no internet connection. Razorpay and public website checks still require internet access.

## Judge demonstration

1. Run **Healthy transaction** and inspect the completed journey.
2. Run **Missing confirmation**. Checkout succeeds, but confirmation fails its business assertion despite HTTP 200.
3. Open the incident. Compare expected and actual results, logs, and the explanation.
4. Approve the supported recovery. Confirm the same order ID, a verified confirmation, and one simulated payment before and after.
5. Use **Checkout unavailable** to show the separate HTTP 500 failure before payment. The automated integration tests cover repeated approval requests and idempotency.

An optional 30-second auto-run works while the dashboard is open. A browser-generated demo session ID isolates each judge's runs and incidents. This mechanism is demo isolation, not production authentication.

See [the two-minute script](docs/demo-script.md), [architecture](docs/architecture.md), and [team schedule](docs/team-roadmap.md).

## Presentation package

- [Current requirements document](<artifacts/deliverables/BizPlus AI Commerce Requirements.docx>)
- [Current requirements PDF](<artifacts/deliverables/BizPlus AI Commerce Requirements.pdf>)
- [Editable seven-slide pitch](<artifacts/deliverables/BizPlus AI Commerce Pitch.pptx>)

The measured results come from actual local and public replays, and the deck uses captured application screenshots. The earlier MVP documents remain in `artifacts/deliverables` as historical releases. The current package clearly marks Supabase setup as pending.

## Deploy the complete app to Render

Use one private GitHub repository containing all three workspaces. Import `render.yaml` as a Blueprint, or create a Node Web Service with the following settings. The build must use the repository root rather than `backend/` so it can compile shared contracts.

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build:backend` |
| Start command | `npm start` |
| Node version | `24.19.0` |
| Health check | `/health` |
| `NODE_ENV` | `production` |
| `HISTORY_POLICY` | `temporary` |
| `DATABASE_PATH` | `.local/bizplus.sqlite` within the backend working directory |
| `SERVE_FRONTEND` | `true` |
| `VITE_API_BASE_URL` | `https://bizplus-ai-api.onrender.com` |
| `CORS_ORIGIN` | `https://bizplus-ai-api.onrender.com` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Backend-only Test Mode keys |

The API listens on `0.0.0.0` and uses Render's `PORT`. `SERVE_FRONTEND=true` makes the repository-root backend build compile the shared contracts, backend, and frontend, then serves frontend assets and known SPA routes from the same public origin. Direct `/shop`, `/live-tests`, and investigation-route refreshes work. API, sandbox, private-file, and unknown paths keep their own responses.

SQLite initializes its schema on startup. Free Render storage is temporary, so hosted history can reset after sleep, restart, or deployment. The UI displays this policy and instance changes. Supabase PostgreSQL is supported but is not connected to this deployment yet. Add a verified PostgreSQL `DATABASE_URL` through Render's environment settings before migrating; the HTTPS Supabase API URL does not work as a database connection. Local SQLite provides the offline sandbox fallback.

The committed `.npmrc` includes development dependencies during installation so TypeScript can compile even when the host sets `NODE_ENV=production`. The current connector-created service uses Render's default TCP health check; configure its Health Check Path as `/health` in the [service settings](https://dashboard.render.com/web/srv-db6sad0m7kps73b684jg/settings). The Blueprint already specifies this path.

## Optional separate Netlify frontend

The current release serves its frontend on Render and needs no Netlify token. If a separate frontend is desired later, import the same repository into Netlify with the base directory at the repository root. `netlify.toml` retains these optional defaults:

| Setting | Value |
| --- | --- |
| Build command | `npm run build:frontend` |
| Publish directory | `frontend/dist` |
| Node version | `24.19.0` |
| `VITE_API_BASE_URL` | Deployed Render HTTPS origin |

Set `VITE_API_BASE_URL` before the build, then redeploy after changing it. `VITE_` variables are public browser configuration and must never contain secrets. After Netlify assigns the frontend URL, set the exact origin in Render's `CORS_ORIGIN` and redeploy the API. The SPA rewrite supports direct routes and refreshes.

The frontend waits for backend readiness before enabling tests. Test the actual cold start before presenting, and open the demo ahead of the judging slot. See [Render Free limits](https://render.com/docs/free), [Render monorepos](https://render.com/docs/monorepo-support), and [Netlify Vite setup](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/).

The current Render service automatically deploys pushed changes to `main`. See [hosting authentication and deployment](docs/deployment-auth.md). The legacy `deploy:check` / `deploy` helper targets the optional separate Netlify frontend and is not required for the current Render release. Provider credentials remain in ignored local files or Render environment variables.

## API contract

Requests for session data include `X-Demo-Session` with the browser's UUID. Use `/health` without a session to check readiness. The shared TypeScript types define run, evidence, assertion, diagnosis, incident, and recovery responses.

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Readiness, instance ID, history policy, diagnosis mode |
| `GET /api/workflows` | The fixed owned workflow and three scenarios |
| `POST /api/runs` | Start a run with `{ "scenario": "healthy" }` and return its run ID |
| `GET /api/runs/:id` | Ordered steps, assertions, response evidence, timings |
| `GET /api/incidents` | Session incidents and fingerprint groups |
| `GET /api/incidents/:id` | Evidence, diagnosis, related incidents, recovery |
| `POST /api/incidents/:id/recover` | Body `{ "action": "resume_receipt_worker", "approved": true }` |
| `GET /api/metrics` | Computed run and recovery metrics, recent history |

The runner only calls fixed sandbox endpoints. It does not accept arbitrary URLs or execute arbitrary commands. One active run per session and bounded request rates keep the public demo predictable. A stable fingerprint uses workflow, step, endpoint, category, and assertion code, excluding changing IDs and timestamps.

Recovery changes `open` to `recovering`, verifies the original order, and resolves the incident only after verification passes. A failed verification returns the incident to `open`. Checkout HTTP 500 receives investigation guidance rather than automatic remediation. The local database defaults to `backend/data/bizplus.sqlite`; use `DATABASE_PATH` to select another runtime location.

## Verification

Run the test and build commands above. Then use the browser through the frontend URL to check healthy and failed runs, approved recovery, metrics, mobile layout, direct route refresh, separate sessions, and temporary history after a hosted restart. The release evidence is in `docs/verification-results.md` when populated by the final verification run.

The private repository excludes secrets, dependency folders, and SQLite runtime files. Keep synthetic data in the sandbox and review the repository before sharing access.

## Prototype limits

Rules generate explanations from captured evidence. They are not LLM output and do not prove causes beyond the sandbox logs. This prototype demonstrates an approved, bounded recovery for one owned workflow. Production authentication, real payment integration, general workflow builders, durable shared storage, and live AI are future work.

Existing tools already support response assertions and AI diagnosis. BizPlus AI's hackathon demonstration connects a missing business outcome to understandable evidence and verified recovery. See [New Relic synthetic assertions](https://docs.newrelic.com/docs/synthetics/synthetic-monitoring/scripting-monitors/write-synthetic-api-tests/) and [Checkly AI root cause analysis](https://www.checklyhq.com/docs/resolve/ai-root-cause-analysis/overview/).
