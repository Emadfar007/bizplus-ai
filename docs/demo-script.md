# BizPlus AI two-minute demonstration

Rehearse with a fresh browser session, auto-run off, the backend ready, and the **Healthy transaction** scenario selected. Keep the local fallback open in a separate tab before the presentation.

| Time | Presenter action | Spoken script |
| --- | --- | --- |
| 0:00–0:15 | Show the Overview | “BizPlus AI checks whether a business transaction actually completes. We use a synthetic shop, so every customer and payment you will see is a test.” |
| 0:15–0:30 | Run Healthy transaction and open the journey | “This request travels through login, inventory, cart, checkout, and confirmation. Each step makes a real HTTP request. We keep the response and its assertions as evidence.” |
| 0:30–0:50 | Run Missing confirmation | “Now we pause the confirmation worker for this transaction. Checkout succeeds. The confirmation endpoint even returns HTTP 200, but the order is missing. Our business assertion catches it.” |
| 0:50–1:15 | Open the incident and expand evidence | “The incident shows the expected order, actual response, timestamps, and the worker log. Our rules explain the evidence and suggest a supported recovery. Related failures share a stable fingerprint.” |
| 1:15–1:40 | Approve recovery and show verification | “I approve resuming this order’s worker. We fetch the original confirmation again. We do not run checkout again. The same order is now confirmed, and the payment count stays at one.” |
| 1:40–1:50 | Show the comparison and incident state | “The incident resolves only when verification passes. The original failed run remains in history, alongside the recovery result.” |
| 1:50–2:00 | Show roadmap or return to Overview | “The MVP makes this recovery easy to understand and audit. Next we would add durable hosting and authenticated operators, then evaluate AI summaries against the captured evidence.” |

## If the host is waking

Say: “The free backend is waking. The readiness screen keeps actions disabled until it is ready.” Continue with the architecture slide. If the host remains unavailable, switch to the tested local tab and repeat the same workflow. State clearly that the fallback is running locally.

## Questions judges may ask

- **Where is the AI?** “This build uses visibly labelled rules. An optional LLM summary is future work. Evidence and safe recovery continue to work without an API key.”
- **Does it retry payments?** “No. Recovery resumes the confirmation worker for the original order. Unique keys and verification check that one payment remains.”
- **How is it different?** “Synthetic assertions and AI diagnosis already exist. Our demonstration combines business-outcome failure, evidence, operator approval, and verification in one small workflow.”
- **Is it production ready?** “It is a synthetic hackathon prototype. Production use needs authentication, durable storage, an audited action policy, and validation on real owned services.”
- **Why did the success rate stay low after recovery?** “The original run failed. We preserve that result and count the verified recovery separately.”
