# Commerce and live website checks

The storefront and live checks extend the original injected-failure demo. Their records are separate: synthetic workflow success metrics do not count shop purchases or live website checks.

## Razorpay Test Mode

Keep credentials in the ignored `.local/integrations.env` file. Node loads this file before normal backend startup; deployment environment variables take precedence.

```dotenv
RAZORPAY_KEY_ID=your_test_key_id
RAZORPAY_KEY_SECRET=your_test_key_secret
RAZORPAY_WEBHOOK_SECRET=your_optional_test_webhook_secret
DATABASE_URL=your_postgresql_connection_string
DATABASE_CA_CERT=your_optional_provider_PEM_CA
```

Only `rzp_test_` keys enable checkout. The key ID is public checkout configuration; the secret stays on the backend. Live keys are refused. Cart requests contain product IDs, quantities, and a checkout UUID; prices and totals come from the server catalog. Orders are capped at ten items, five of each product, and ₹10,000.

Enable Test Mode automatic capture in the merchant dashboard. Open `/shop`, add products, then choose **Pay with Razorpay**. The real Razorpay test checkout supports mock netbanking success/failure and documented test cards. A verified paid receipt requires the same stored provider order, a valid HMAC signature, captured payment status, exact INR amount, and matching paid provider-order totals. Test payments move no real funds. [Official integration and test instructions](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)

For callbacks lost when a browser closes, configure the optional `payment.captured` webhook to the deployed `/api/shop/webhook` URL and store its separate signing secret on the backend. The webhook validates raw bytes and rechecks provider details. Duplicate callbacks/events cannot create a second payment record. Delayed captures after a received callback also reconcile through read-only order-detail requests. Unknown provider creation outcomes stay blocked rather than blindly creating another order.

## Supabase PostgreSQL

Use a separate project. In the Supabase dashboard, click **Connect → Session pooler**, copy the PostgreSQL URI, and replace the password placeholder. `DATABASE_URL` must begin with `postgresql://` or `postgres://`; the HTTPS project API address is a different setting. Save the file before restarting the backend. Percent-encode reserved password characters in the URI. [Supabase connection instructions](https://supabase.com/docs/guides/database/connecting-to-postgres)

The backend owns a private `bizplus` schema with RLS and no browser/Data API grants. All database and provider credentials stay server-side. Supply the provider PEM root through `DATABASE_CA_CERT` if its certificate is not trusted by Node. Certificate checks remain enabled. A configured database connection failure stops startup instead of silently reverting to SQLite.

Follow [the read-only export and repeatable migration](../backend/database.md) to copy existing local history while preserving the source database. Never commit either root `integrations.env` or `.local/integrations.env`, SQLite files, snapshots, or secrets. In Render, use environment variables; local credential files are excluded from the repository.

## Live website targets

The default approved target is `https://bizplus-ai-api.onrender.com/health`. The server's `LIVE_TARGETS` environment variable can define up to ten additional owned HTTPS targets:

```json
[{"id":"my-store","name":"My owned store","url":"https://your-owned-host.example/status","expectedStatus":200,"containsText":"Store online"}]
```

Requests are read-only, bounded to twelve seconds and 512 KB, and do not send cookies or credentials. URLs cannot contain authentication, query parameters, fragments, or alternate ports. DNS resolves to public addresses and is pinned for the request; redirects stay on the original HTTPS origin. Browser requests choose a configured target ID and cannot submit arbitrary URLs. One active live run per session and request rates apply.

The first real check recorded HTTP 503 as the free Render service woke; later checks passed HTTP 200 with the expected JSON content. A local browser-triggered sample measured 117 ms; the public Render frontend sample measured 79 ms. These are individual observed samples, not performance guarantees.

## Verified scope

The expanded automated suite passed 33/33 checks, including an actual local PostgreSQL instance, payment signature/tampering/idempotency, delayed capture reconciliation, live target restrictions, transient persistence failures, and bounded frontend hosting. Both local and public Render browsers completed actual Razorpay Test Mode purchases with server-verified receipts and empty carts after payment; refresh retained the receipts. Desktop and 390-pixel mobile layouts had no document overflow. Live checks used the real Render endpoint and actual response evidence.

Hosted Supabase remains unverified until its PostgreSQL connection is supplied. The complete frontend and API are published on [Render](https://bizplus-ai-api.onrender.com), including direct storefront and live-test routes. `SERVE_FRONTEND=true` builds and serves the frontend from this backend; `VITE_API_BASE_URL` and `CORS_ORIGIN` use its exact public origin. The feature is opt-in, and the original Netlify configuration remains optional. Static serving is limited to frontend assets and known SPA routes; API, sandbox, and private-file paths are never rewritten to HTML.
