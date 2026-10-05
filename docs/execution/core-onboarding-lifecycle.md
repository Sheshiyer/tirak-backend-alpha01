# Core connected application lifecycle

Core individual-guide intake persists structured profile details, service drafts and explicit Bangkok weekly availability. When supplied, schedules cover all seven weekdays once. Application capabilities allow protected status recovery and private evidence uploads.

Admin approval requires all three identity evidence kinds and provisions a distinct pending guide account, pending guide profile, inactive service drafts, availability and the application account/reviewer links in one D1 batch. Approval and rejection use conditional writes; retries read the actual winning state. Existing email identities are held for review without silent traveler conversion. Missing, malformed or invalid stored application details block approval before provisioning.

QA approval additionally requires an active QA admin and atomically enrolls the approved guide with application/reviewer provenance. Account activation through a single-use invitation remains separate from admin profile verification and owner service activation. Trial expiry is thirty days; public eligibility also requires an active account, verified profile and active unarchived service. Payments remain disabled, and booking confirmation or completion never changes payment status to paid.

Selected schema changes target only the newly isolated Core QA resources after runtime proof and an empty-database guard. No blanket migration command or retained live target is admitted by this document. Local real SQLite contention/fault tests and the parent regression suite establish source behavior; hosted D1, runtime, delivery and device evidence are recorded separately.

Email status reports observed provider outcomes. QA recipient restrictions are enforced centrally, and QA hosting initially keeps email disabled. A queued or accepted invitation is not evidence of inbox receipt. Expired/failed invitations use the account recovery path after authorized transport setup.
