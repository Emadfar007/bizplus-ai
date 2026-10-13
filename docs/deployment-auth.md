# Local deployment access and resume

The project targets a public Netlify frontend and a **free** Render backend, with source kept in the existing private [GitHub repository](https://github.com/Emadfar007/bizplus-ai).

Signing into a provider website does not authenticate its API. For the local deployment helper, create a Netlify personal access token and a Render API key using the providers' [Netlify API guide](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/) and [Render API guide](https://render.com/docs/api). Store their values only in the ignored `.local/deployment.env` file:

```dotenv
NETLIFY_AUTH_TOKEN=
RENDER_API_KEY=
```

Do not paste tokens into chat, commit them, or put them in frontend `VITE_` variables. The local `scripts/deploy-hosts.mjs` convenience helper is intentionally ignored and is available in the original project workspace; normal provider setup remains documented in the README.

From the project root, using the tested Node 24 installation:

```powershell
& 'C:\Program Files\nodejs\node.exe' scripts/deploy-hosts.mjs --check
& 'C:\Program Files\nodejs\node.exe' scripts/deploy-hosts.mjs --plan
& 'C:\Program Files\nodejs\node.exe' scripts/deploy-hosts.mjs --deploy
```

`--check` and `--plan` are read-only. They report credential-presence booleans and safe account/workspace names. The helper requires one verified personal Netlify Free/Starter account and one Render workspace before creating anything. If selection is ambiguous, add the intended selector from the reported choices to the same ignored file:

```dotenv
# Optional account selectors, not credentials:
NETLIFY_ACCOUNT_SLUG=
RENDER_OWNER_ID=
```

Before deployment, local `main` must be clean and match the remote `main` commit. Render must have GitHub-app access to `Emadfar007/bizplus-ai`. If Render rejects repository access, grant access to this private repository; keep the source private.

`--deploy` creates at most one unique Netlify site and one free Render service for this saved deployment. It uses repository-root builds, Node 24.19.0, `/health`, temporary SQLite history, and the exact frontend CORS origin. It builds the frontend with the actual Render URL and uploads only `frontend/dist`, including SPA redirects and response headers. Automatic backend deploys are disabled; use `--redeploy` after committing and pushing later changes when a fresh deployment is intended.

Nonsensitive site, service, and deployment IDs are saved immediately in `.local/deployment-state.json`. Rerun `--deploy` to resume a slow or interrupted operation. Unknown API outcomes are reconciled against saved names and IDs; the helper stops rather than creating another resource. Keep the state file. A leftover `.local/deployment.lock` should only be removed after confirming that the corresponding helper process has ended.

The helper refuses paid upgrades, persistent disks, extra services, or changes to existing unrelated resources. If a provider requests billing or reports exhausted free limits, it stops for review.

Host checks verify backend health, temporary-history policy, exact CORS origin, and frontend SPA routing. They do **not** replace browser acceptance tests: complete the healthy run, both failures, approved recovery, idempotent retry, session isolation, mobile layout, refresh, and cold start through the public URL before calling the deployment complete.

