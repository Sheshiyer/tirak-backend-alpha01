# Agent operating contract

This repository is `tirak-backend-alpha01`.

1. Read `PROJECT.md` and `.project/HANDOFF.md` before starting work.
2. Treat the Thoughtseed Labs vault as referenced knowledge, never as a
   runtime dependency or a place to copy private notes, transcripts, or
   seed corpora.
3. Preserve the existing tooling and deployment boundaries. Use the
   commands declared in `PROJECT.md` and keep generated output ignored.
4. Keep changes scoped to this repository. Do not edit vault registries,
   native client stores, Paseo, OmniRoute configuration, provider
   credentials, or external deployment state without a separate
   owner-approved task.
5. Never add secrets, `.env` material, native session identifiers, prompt
   or response bodies, or machine-local absolute checkout paths.
6. Record a bounded checkpoint in `.project/HANDOFF.md` when a reviewed
   change is ready for another client to pick up.

This packet is draft-held. Identity recording does not authorize
relocation, registry writes, session migration, or deployment changes;
those remain manifest-gated and require this packet to first be reviewed
and moved to `reviewed-held`.
