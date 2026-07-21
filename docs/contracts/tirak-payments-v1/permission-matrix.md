# Payment and Restitution Permission Matrix

| Operation | Traveler | Assigned guide | Support operator | Financial approver | Webhook/reconciler |
| --- | --- | --- | --- | --- | --- |
| create PromptPay attempt | own confirmed booking only | deny | deny | deny | deny |
| read/reconcile charge | own booking only | deny | read-only with case | read-only | exact provider charge only |
| cancel unpaid booking | allowed only with no active/unresolved/successful attempt | allowed only with no active/unresolved/successful attempt | case workflow | case workflow | deny |
| request restitution | deny direct ledger write | deny | create pending case with reason | approve or reject | flag exceptional success only |
| mark restitution complete/failed | deny | deny | deny | required, with recipient/evidence/timestamp | deny |
| change production creation flag | deny | deny | deny | named human release owner through audited configuration | deny |
| rewrite Omise charge outcome | deny | deny | deny | deny | deny |

## Enforcement contract

- Mobile clients cannot write payment, webhook, or restitution tables.
- Customer APIs derive ownership from the authenticated user and booking row.
- A restitution is unique per originating successful attempt and provider charge.
- Terminal restitution requires an approver and evidence. `restituted` also requires recipient reference and completion timestamp; `restitution_failed` requires failure reason and timestamp.
- Provider truth is immutable. Restitution closes a customer-resolution case but never changes an Omise successful charge to refunded.
