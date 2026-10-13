# Team ownership and six-hour schedule

One private repository contains the frontend, backend, and shared contracts. Work on separate branches and merge small changes at each integration checkpoint. Agree the contract before independent feature work.

| Owner | Modules and deliverables | Integration handoff |
| --- | --- | --- |
| You | Backend, SQLite, owned sandbox, workflow runner | Shared API contracts, readiness endpoint, connected run |
| Member 2 | React dashboard, workflow progression, charts, responsive layout | Actual API data and browser verification |
| Member 3 | Rules, fingerprints, recovery checks, deployment | Evidence-linked incidents and hosted verification |

Database helpers remain under backend ownership. Share changes to `shared` before merging dependent frontend or intelligence changes. Resolve contract disagreements before adding another field to a response.

| Time | Checkpoint |
| --- | --- |
| 0–30 minutes | Scaffold, contract, health endpoint, dashboard shell, repository |
| 30–60 minutes | Deploy the skeleton while the engine and UI work continue |
| 1–3 hours | Real HTTP runs, assertion evidence, incidents, rules, fingerprints |
| 3–4 hours | Approved recovery and the integrated public core |
| 4–5 hours | Public URL tests, cold start, responsive polish, defects |
| 5–6 hours | Requirements document, screenshots and deck, demo script, two rehearsals |

Freeze new features at hour four. In the final hour, the backend owner prepares requirements and architecture, the frontend owner prepares screenshots and slides, and Member 3 checks the demo and measured results.

## Release checklist

- Healthy workflow completes all steps with matching amount and order.
- Checkout 500 fails before payment and skips dependent steps.
- Missing confirmation triggers an incident even with HTTP 200.
- Diagnosis cites the captured evidence.
- Explicit recovery approval preserves the order and payment count.
- Repeated approval is harmless and failed verification remains open.
- Separate browser sessions cannot operate on each other’s incidents.
- Metrics derive from persisted records.
- Public URL, cold start, incognito, refresh, mobile layout, and local fallback work.
- Secrets and runtime databases remain outside source control.
- Requirements pages and all seven pitch slides are visually checked.
