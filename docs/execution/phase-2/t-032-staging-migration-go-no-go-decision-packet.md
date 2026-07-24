# T-032 — Approve Staging Migration Go/No-Go · Decision Packet

Status: **SIGNED — GO (2026-07-24, human release owner)**
Prepared: 2026-07-24
Task: GitHub issue `Sheshiyer/tirak-mobile-app-v2#32` — "[T-032] Approve staging migration go/no-go"
Wave: W2.1 close · Swarm: integration-gate
Owner: Release integrator / noesisX
Estimate: 2 hours
Dependencies: T-031 ✅ (executed 2026-07-24, PR #21 merged `cf26d06e…`)

Deliverable (verbatim): *"Signed migration decision with abort triggers"*.
Acceptance (verbatim): *"Zero unexplained schema drift or unrecoverable operation remains"*.
Validation (verbatim): *"Wave-close evidence review"*.

> **This packet decides; it does not execute.** No migration, restore, or staging
> mutation is performed under this document. The application of the canonical lineage
> to active staging is W2.2 scope and happens **only after a signed GO**, under a fresh
> recovery point, bound by the pre-conditions and abort triggers registered below.

---

## 1. The decision question

Authorize (**GO**) or refuse (**NO-GO**) the future application of the canonical
migration lineage —

1. `canonical-baseline.sql`
2. `008_omise_promptpay_payments.sql`
3. `010_booking_chat_expansion.sql`
4. `011_payment_restitutions.sql`

— to active staging D1 **`tirak-staging`** (uuid `5132c8cc-8f23-4dd2-94d1-9d53edb92888`,
pinned Cloudflare account `2c0c96c68f0ee73b6d980054557bca5b`).

A GO is not a blank authorization. It is bound to:

- the **binding pre-conditions** in §6, which constrain how the W2.2 execution must run, and
- the **pre-registered abort triggers** in §7, under which the W2.2 execution must halt.

A NO-GO halts the wave at this gate; see the NO-GO path in §9.

## 2. Authority boundary

Published under the recorded T-024 human approval. **This packet authorizes no mutation
by itself.** It records a human decision that gates the later W2.2 execution, which
runs under its own authority chain (fresh recovery point, isolated apply roots, human
two-party confirmation at each gate).

Prohibited under this packet and under any execution it gates: production mutation,
live Omise charging, App Store submission, and bypassing later human gates. Active
staging remains untouched until a signed GO is followed by the W2.2 execution
satisfying every pre-condition in §6.

## 3. Wave-close evidence review

The wave-close review examines the complete W2.1 evidence chain (T-025 → T-031). Every
claim below is backed by merged evidence in the backend repo
(`Sheshiyer/tirak-backend-alpha01`, `docs/execution/phase-2/`), under the PR #15–#21
pattern.

| Task | Evidence location | PR | Key result |
| --- | --- | --- | --- |
| T-025 — staging identities | `docs/execution/phase-2/t-025-staging-resource-ledger.json` (backend repo) | #15 merged | Fingerprint `52431d70…f10` human-confirmed 2026-07-21; pristine-empty invariant established |
| T-026 — recovery point | `t-026-recovery-point-evidence.md` + ledger | #16 merged | Capture → export → disposable-restore → verify → teardown chain proven; restore-by-overwrite forbidden (migration-strategy.md line 65) |
| T-027 — schema inspection | `t-027-staging-schema-inspection.md` | #17 merged | Divergence rows E1–E17 identified (no repo migration created `payment_restitutions`) → motivated authoring of 011 |
| T-028 — migration lineage | `t-028-migration-lineage-evidence.md`, commit `7d93746` | #18 merged | Canonical baseline sha256 `b6532c80e5eeb6b481c26f5ad12f58043f8ad77587ea503527f6cb94e47cf33f`; `verify-lineage.mjs`; quarantine of `004_mobile_app_features.sql` and destructive `009_booking_scoped_chat.sql`; 29/29 migration tests |
| T-029 — rehearse 008 | `t-029-rehearsal-evidence.md` + ledger | #19 merged (merge commit `a095da7`) | Baseline+008 applied cleanly on disposable DB, contract-exact, FK-clean, duplicate-attempt guard live; successor fingerprint `3b57299a2a7cadc048243a18aeae8cc6d568b548eacf3edcfaa5ddbc24eef7cc` human-confirmed (change explained: T-028 lineage merge altered local fingerprint input; remote staging verified unchanged) |
| T-030 — rehearse 010+011 | `t-030-rehearsal-evidence.md` + ledger | #20 merged (`d3fbd4d1…`) | Full lineage baseline+008+010+011 applied on disposable `tirak-t030-rehearsal`: exactly 4 ledger rows; 14/14 contract objects exact; FK check 0 violations; legacy `chat_rooms`/`chat_messages` preserved untouched; dual-Worker compatible; one-room-per-booking UNIQUE enforced; restitution uniqueness + three-state lifecycle CHECK enforced; teardown verified. 011 folded in under the approved 2026-07-24 scope amendment |
| T-031 — independent validation | `t-031-validation-evidence.md` + ledger (the "independent migration and restore report") | #21 merged (`cf26d06e…`) | Isolated re-derivation: 34/34 checksums verified; restore of T-030 post-apply export into fresh `tirak-t031-validation` (365 rows, 40 tables, 0 errors/skips); 14/14 objects, FK 0, row counts exact vs T-030 baseline across all 40 tables, restored ledger carried intact (4 rows, preserved applied_at), verify-lineage exit 0; teardown verified |

## 4. Acceptance mapping — *"Zero unexplained schema drift or unrecoverable operation remains"*

### 4.1 Explained-drift register — every observed drift is EXPLAINED

| # | Observed drift | Explanation | Closure |
| --- | --- | --- | --- |
| (a) | Fingerprint transition `52431d70…f10` → `3b57299a…eef7cc` | T-028 lineage merge altered the local fingerprint input; remote staging verified unchanged | Human re-confirmed during T-029; carried through T-030 and T-031 pre-flight gates |
| (b) | E1–E17 schema divergences (T-027) | No repo migration created `payment_restitutions`; divergences explained by inspection | Closed by 011 authoring + T-030 rehearsal proof + T-031 independent validation (14/14 contract objects exact) |
| (c) | Stale "009" naming (issue #30 title, ISA ISC-153, branch-worktree manifest) | Cosmetic numbering drift; the destructive `009_booking_scoped_chat.sql` is quarantined and forbidden | Explained; tracked in residuals (§8, item 1) for wave-close reconciliation |
| (d) | ISA ISC-149–155 ledger unchecked | Bookkeeping gap, not schema drift | Explained; tracked in residuals (§8, item 2) |

No unexplained drift remains in the register.

### 4.2 No unrecoverable operation remains

- **All disposable databases deleted and absence-verified** — T-026, T-029, T-030, and
  T-031 teardowns each closed with `d1 list` absence verification and an unchanged
  post-teardown discovery fingerprint.
- **Staging pristine throughout the wave** — active `tirak-staging` holds
  `num_tables: 0` with **zero writes across the entire wave**; every capture was
  read-only (T-026 chain discipline).
- **Restore chain proven three times** — T-026 (pristine staging export), T-030 (full
  lineage baseline+008+010+011), T-031 (independent restore of the T-030 post-apply
  export: 365 rows, 40 tables, 0 errors/skips, ledger carried intact).
- **The only pending mutations are the ones this decision governs.** Nothing outside
  the canonical lineage application is outstanding; restore-by-overwrite of
  staging/production remains contract-forbidden (migration-strategy.md line 65).

Acceptance verdict: the evidence satisfies *"Zero unexplained schema drift or
unrecoverable operation remains."*

## 5. What a GO authorizes — and what it does not

A GO authorizes the W2.2 execution to apply the canonical lineage
(`canonical-baseline.sql` + `008_omise_promptpay_payments.sql` +
`010_booking_chat_expansion.sql` + `011_payment_restitutions.sql`) to active
`tirak-staging`, **subject to every pre-condition in §6 and every abort trigger in §7**.

A GO does **not** authorize: production mutation, live Omise charging, App Store
submission, secret mutation, or deviation from the binding pre-conditions. The W2.2
execution operates under its own runbook and human gates; this decision is its entry
ticket, not its execution plan.

## 6. Binding pre-conditions on a GO

These conditions are **binding on the W2.2 execution**. A GO is void as to any
execution that does not satisfy all of them:

1. **Fresh recovery point immediately before apply** — a full T-026-chain recovery
   point on `tirak-staging` (time-travel bookmark + export) captured immediately
   before the apply, with the T-026 export-URL redaction rule in force.
2. **Isolated apply roots** — migrations are applied from isolated roots with
   dedicated configs; **never** the repo `wrangler.toml` migrations root, which
   contains the quarantined files (`004_mobile_app_features.sql`,
   `009_booking_scoped_chat.sql`).
3. **Apply order** — baseline root first, then the lineage root in filename order:
   008 → 010 → 011.
4. **Post-apply verification** — the full T-031 probe set re-run against staging:
   contract-surface exact match (14/14 objects), `PRAGMA foreign_key_check` zero
   rows, ledger exactly 4 rows in canonical order with `verify-lineage.mjs` exit 0,
   and no quarantined filename present.
5. **Human two-party confirmation recorded at each gate** — every execution gate
   (pre-flight, apply, post-apply verification, closure) carries a recorded human
   two-party confirmation, per the T-026/T-029/T-030/T-031 gate discipline.

## 7. Pre-registered abort triggers for the W2.2 staging application

These triggers are **pre-registered binding conditions on a GO**. If any fires during
the W2.2 execution, the execution halts immediately, preserves all evidence
append-only, and does not retry without diagnosis and re-approval:

1. **Fingerprint drift** — apply-time pre-flight fingerprint ≠
   `3b57299a2a7cadc048243a18aeae8cc6d568b548eacf3edcfaa5ddbc24eef7cc`.
2. **Staging no longer pristine** — `num_tables` ≠ 0 at pre-flight.
3. **Baseline regeneration hash drift** — regenerated canonical baseline ≠
   `b6532c80e5eeb6b481c26f5ad12f58043f8ad77587ea503527f6cb94e47cf33f`.
4. **Any apply error or partial ledger write** — halt, preserve append-only evidence,
   no retry without diagnosis.
5. **Ledger deviation** — any deviation from the canonical 4 rows
   (`canonical-baseline.sql`, `008_omise_promptpay_payments.sql`,
   `010_booking_chat_expansion.sql`, `011_payment_restitutions.sql`), or any
   quarantined filename (`004_mobile_app_features.sql`, `009_booking_scoped_chat.sql`)
   appearing.
6. **Post-apply verification failure** — any FK violation or contract-object mismatch
   after apply.
7. **Wrong write target** — any write target other than `tirak-staging` itself.

## 8. Residuals register

Open items that do not block this decision, each with a recorded disposition:

| # | Residual | Disposition |
| --- | --- | --- |
| 1 | Stale "009" naming — issue #30 title, ISA ISC-153, and the branch-worktree manifest say "009"/"additive-migration-009" while the quarantined `009_booking_scoped_chat.sql` is forbidden | Reconcile issue #30 title + ISA ISC-153 + branch-worktree manifest at wave close (cosmetic) |
| 2 | ISA ISC-149–155 completion update pending | Close the ISA bookkeeping at wave close; not schema drift |
| 3 | Full-scope token rotation | REQUIRES separate secret-mutation authority; recommended before any production apply; not mutated under this packet |
| 4 | `t-025-staging-resource-ledger.json` mode-0644 checkout artifact | Local hygiene only, no content impact |

## 9. Signature block

**Decision:**

- ☑ **GO** — authorize application of the canonical lineage to `tirak-staging` under
  the binding pre-conditions (§6) and pre-registered abort triggers (§7).
- ☐ **NO-GO** — refuse application; invoke the NO-GO path below.

| Field | Entry |
| --- | --- |
| Human name | Sheshiyer — human release owner |
| ISO date | 2026-07-24 |
| Confirmation statement (GO) | *"I authorize application of the canonical lineage baseline+008+010+011 to tirak-staging under the registered abort triggers and pre-conditions."* |
| Signature | Signed via owner chat approval 2026-07-24 (verbatim: "yes proceed", given in direct response to the GO/NO-GO signature request for this packet); recorded verbatim by the orchestrator — no statement fabricated |

**NO-GO path:** the wave halts at this gate. All wave evidence is quarantined with a
recorded owner and review date, and issue `Sheshiyer/tirak-mobile-app-v2#32` is
commented with the reasons for refusal. No staging application proceeds; re-entry
requires a fresh decision packet after the blocking findings are resolved.

## 10. Post-signature evidence closure

After the human signs:

1. A **sanitized comment on issue `Sheshiyer/tirak-mobile-app-v2#32`** records the
   decision (GO or NO-GO), the signing human, and the ISO date — no secrets, no
   tokens, no export URLs.
2. This packet's **canonical copy commits to the backend repo** at
   `docs/execution/phase-2/t-032-*` under the PR #15–#21 pattern (scoped commit → PR;
   the human closes the PR).
3. On a GO, W2.2 opens under its own runbook, entering through the binding
   pre-conditions in §6 with the abort triggers in §7 already registered.
