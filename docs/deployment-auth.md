# Render hosting and optional deployment helper

The current complete frontend and API run on the existing **free Render** service at [bizplus-ai-api.onrender.com](https://bizplus-ai-api.onrender.com). Source remains in the private [GitHub repository](https://github.com/Emadfar007/bizplus-ai). The confirmed workspace is **BizPlus AI**.

Render uses repository-root `npm ci && npm run build:backend`, then `npm start`, with Node 24.19.0. Set `SERVE_FRONTEND=true`, and use the exact public Render origin for `VITE_API_BASE_URL` and `CORS_ORIGIN`. The service automatically deploys pushes to `main`; do not trigger a second deployment for the same push. Razorpay Test Mode keys stay in backend environment variables. Supabase is pending a valid PostgreSQL connection string; current hosted history is temporary SQLite.

## Optional Netlify helper

The following helper supports the original separate Netlify frontend design. It is **not needed for the deployed Render frontend**.

Signing into a provider website does not authenticate its API. The Render service identity is saved locally in `.local/render-native.json`. To use the optional Netlify helper, create a Netlify personal access token using the [Netlify API guide](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/) and store its value only in the ignored `.local/deployment.env` file:

```dotenv
NETLIFY_AUTH_TOKEN=
```

Do not paste tokens into chat, commit them, or put them in frontend `VITE_` variables. The helper source `scripts/deploy-hosts.mjs` is committed; credentials and deployment state under `.local` are ignored.

From the project root, using the tested Node 24 installation:

```powershell
& 'C:\Program Files\nodejs\node.exe' scripts/deploy-hosts.mjs --check --netlify-only
& 'C:\Program Files\nodejs\node.exe' scripts/deploy-hosts.mjs --plan --netlify-only
& 'C:\Program Files\nodejs\node.exe' scripts/deploy-hosts.mjs --deploy --netlify-only
```

`--check` and `--plan` are read-only. They report credential-presence booleans and safe account/workspace names. Netlify-only mode requires one verified personal Netlify Free/Starter account and reuses the existing native Render service. It never queries or changes Render resources. If Netlify selection is ambiguous, add the intended account selector from the reported choices to the same ignored file:

```dotenv
# Optional account selectors, not credentials:
NETLIFY_ACCOUNT_SLUG=
```

Before deployment, local `main` must be clean and match the remote `main` commit. Render must have GitHub-app access to `Emadfar007/bizplus-ai`. If Render rejects repository access, grant access to this private repository; keep the source private.

`--deploy --netlify-only` creates at most one unique Netlify site for this saved deployment. It prints the assigned exact frontend `CORS_ORIGIN`; apply that value through the Render connector, then rerun the same command. It verifies backend health, temporary history, and CORS before building with the actual Render URL and uploading only `frontend/dist`, including SPA redirects and response headers. Use `--redeploy --netlify-only` for a new frontend release. The existing native Render backend automatically deploys when its `main` branch changes.

For a fresh deployment without a Render connector, the helper's original dual-provider mode remains available. Supply `RENDER_API_KEY` locally, optionally `RENDER_OWNER_ID` when account selection is ambiguous, and omit `--netlify-only`. This mode provisions its own free Render service with `/health`, temporary history, and automatic deploys disabled. Do not use it to create a second backend for the current native deployment.

Nonsensitive site, service, and deployment IDs are saved immediately in `.local/deployment-state.json`. Rerun `--deploy` to resume a slow or interrupted operation. Unknown API outcomes are reconciled against saved names and IDs; the helper stops rather than creating another resource. Keep the state file. A leftover `.local/deployment.lock` should only be removed after confirming that the corresponding helper process has ended.

The helper refuses paid upgrades, persistent disks, extra services, or changes to existing unrelated resources. If a provider requests billing or reports exhausted free limits, it stops for review.

Host checks verify backend health, temporary-history policy, exact CORS origin, and frontend SPA routing. They do **not** replace browser acceptance tests: complete the healthy run, both failures, approved recovery, idempotent retry, session isolation, mobile layout, refresh, and cold start through the public URL before calling the deployment complete.

