# BizPlus AI design handoff

[Editable Figma file](https://www.figma.com/design/344gY1vPHJBMCDec9nO2lq) · [Render app](https://bizplus-ai-api.onrender.com)

The redesign puts an action and its result ahead of charts, groups navigation into Monitor and Explore, and makes the demonstration sequence visible. Investigation separates observed facts from possible causes. Technical fingerprints and JSON evidence remain available through disclosure controls. Recovery keeps the original failure and original-order verification together.

## Figma features

- Primitive and semantic color variables use explicit scopes and aliases. Geometry variables cover spacing, corner radii and the 44 px minimum control height. Web code syntax maps the tokens to CSS custom properties.
- Inter text styles define caption, body, label, value and title sizes. Text nodes wrap within their containers and use automatic height.
- Native Auto Layout frames define desktop and phone layouts. The mobile views use a 390 × 844 scroll viewport.
- Button, status badge, navigation, scenario tile, metric and product components provide reusable variants. Buttons and cards have editable text properties; navigation and product artwork use instance-swap properties. Navigation icon modes preserve the active mint state after swaps.
- Linked prototypes cover healthy execution, failure, investigation, approval and verified recovery. Store and live-check links open the deployed app. The phone storefront has a scroll-to-cart shortcut.
- Product illustrations remain editable native SVG vectors in Figma. The app serves the exact exported SVG assets locally, preserving their 180 × 145 geometry.

## Screen mapping

| Figma node | Design state | Application |
|---|---|---|
| `12:149` | Overview | `/` before a run |
| `12:333` | Healthy result | `/` after a passing run |
| `12:508` | Failed business outcome | `/` after missing confirmation |
| `12:694` | Review and approve recovery | `/recovery/:id` before approval |
| `12:833` | Verified recovery | `/recovery/:id` after verification |
| `12:972` | Storefront | `/shop` |
| `12:1260` | Live checks and fault lab | `/live-tests` |
| `12:1393` | Phone overview | `/` at 390 px |
| `12:1499` | Phone storefront | `/shop` at 390 px |

The prototype demonstrates fixed states; the deployed product executes real requests and renders captured evidence. Chart data is never copied from a mockup. Conditional investigation and observer states use actual responses, including explicit unavailable/configuration states.

## Implementation and accessibility

`frontend/src/design-system.css` maps the Figma tokens and core layouts. `commerce.css` contains the storefront and live-check layouts. Inter is bundled locally through Fontsource; no external font request is required. Six Figma product exports are in `frontend/public/assets/figma`.

The app supports keyboard navigation, a skip link, route heading focus, menu Escape dismissal, focus restoration, and inert closed navigation. Dialogs make surrounding content inert. Selected scenarios, receipts and history entries expose their selected state. Runs, recovery results and cart changes are announced. Main controls and evidence links have 44 px touch targets. Reduced-motion preferences are respected.

Checkout still uses server prices, session ownership, the original order key, signature verification and provider read-back. The ten-item cart limit prevents extra additions and blocks an oversized stored cart without silently trimming it. Hosted receipt copy reports the actual history policy.

## Verification

The redesign was checked at desktop and 390 × 844 phone sizes. Full user journeys and the public Render release are recorded in `artifacts/verification/figma-redesign.json`; screenshots are in `artifacts/screenshots/figma-redesign`. Earlier Razorpay and live-fault evidence remains separately labelled with its original release and timestamps.

The hosted service currently uses temporary SQLite history. Supabase deployment still needs a valid PostgreSQL connection URI; visual redesign does not change that configuration.
