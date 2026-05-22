# Legacy Backend To Tirak Plus Contract Map

Date: 2026-05-18

This map supports INT-006 and freezes the vocabulary boundary for Wave 1.

## Role Vocabulary

| Existing backend | Tirak Plus product | Migration posture |
|---|---|---|
| `customer` | `traveller` | Keep DB enum for now. Translate at API adapter and UI boundary. |
| `supplier` | `companion` | Keep DB enum for now. Translate at API adapter and UI boundary. |
| `admin` | `operator` / `admin` | Keep `admin` for backend auth. Use operator language for human workflow copy where useful. |

## Domain Vocabulary

| Existing backend concept | Tirak Plus contract | Required guardrail |
|---|---|---|
| Booking | Inquiry, plan, or booking depending on compliance approval | Do not make payment or direct booking the first product path. |
| Supplier services | Companion offerings / experience fit | Copy must stay non-objectifying and safety-aware. |
| Review/rating | Admin-only quality/audit signal | Do not expose star-rating marketplace UI as the public discovery driver. |
| Subscription | Companion visibility/business account state | Keep payment/provider logic behind compliance gates. |
| Customer preferences | Traveller Muse calibration | Store consented preference profiles; avoid permanent opaque zodiac labels. |
| Search suggestions | Muse intent suggestions and discovery hints | Suggestions must not imply fake urgency or unsafe availability. |
| Chat rooms/messages | Conversations and inquiry handoff | Respect privacy defaults and admin access rules. |

## API Boundary Rules

- New customer-facing APIs should prefer `traveller` and `companion` terms.
- Existing persisted enums can remain `customer` and `supplier` until a migration is explicitly approved.
- Admin APIs may expose both legacy and product terms during transition when it improves traceability.
- Muse should call adapter/service code, not query legacy tables directly from route handlers.

## Muse Contract Seeds

The first `/api/muse` contract should include:

- `POST /api/muse/session`: start or resume a Muse session.
- `POST /api/muse/consent`: record AI personalization and age-gate consent events.
- `GET /api/muse/consent`: read the current consent state.
- `POST /api/muse/calibration`: save traveller preference calibration.
- `POST /api/muse/recommendations`: create deterministic recommendation runs before external AI is introduced.
- `POST /api/muse/companion-assist`: create editable companion onboarding drafts without auto-publishing.

## Public UX Guardrails

- Discovery can use fit, context, availability window, verification, language, region, and experience style.
- Discovery must not lead with public star ratings, fake online status, swipe mechanics, explicit services, or red-light styling.
- Birth date may support age gate and optional personalization only after consent.
- Zodiac/personality-style inference must be explainable as lightweight personalization, not deterministic identity profiling.
