# @elizaos/corpus-tools

Private workspace package for the personal-corpus program (#14747/#14748). It
owns the canonical corpus JSONL schema, synthetic fixtures, validators, and
mock-shape mappers consumed by later collector, PII, and LifeOps mock-loader
work.

The iMessage collector in `src/collectors/imessage.ts` consumes the strict,
read-only backfill API from `@elizaos/plugin-imessage`. It streams a stable
SQLite snapshot into monthly shards under one marker-owned private root and
publishes the account generation, manifest, and keyed omission receipt through
a recoverable journal.

## Rules

- Raw, owner, or intermediate corpus data never enters git. Use ignored
  `data/`; commit only synthetic fixtures under `fixtures/`.
- `src/schema.ts` is the boundary contract for collectors and scrub stages.
  Widen additively and update validators/tests with every schema change.
- Mappers are compatibility adapters, not schema owners. Keep platform-specific
  compromises, such as X-to-generic-channel mapping, documented at the mapper
  boundary.
- Validator failures are data errors; return structured diagnostics from the
  library and let only the CLI translate them to stdout/stderr and exit codes.
- iMessage collection roots must be absent or carry the collector ownership
  marker, be private to the current user, and be gitignored when they are inside
  a repository. Cleanup removes only nonce directories whose marker matches the
  root token; it never chmods or recursively removes caller-owned directories.
- Unavailable attachment bytes fail collection by default. The explicit
  `record-omission` policy writes keyed omission receipts without fake hashes,
  invented text, or a widening of the shared message schema.
- iMessage receipts bind the manifest schema version, cutoff, account shard
  paths, counts, and hashes. They intentionally exclude only `generatedAt`,
  which is volatile global metadata refreshed by every corpus publisher.
- Marker-owned snapshot and generation directories retire into empty,
  marker-only `.removing` recyclers. Reuse keeps residue bounded while avoiding
  an unsafe path-based `rmdir` after descriptor-relative cleanup. A cleanup
  identity race restores the mismatched replacement before it fails closed.
- First-run root preparation uses one fixed private claim; snapshot and stage
  allocations plus atomic publication temporaries use fixed root-token-bound
  names. The next locked collector run repairs killed partial markers and
  reclaims killed temporaries, so repeated process death cannot create
  unbounded UUID residue.
- Verification is corpus-wide, non-mutating, and fail-closed. A row-level stage
  may not assign `scrubState: "verified"`; publication reruns the complete gate
  against every bound input, and its declared scope must not imply multimodal
  coverage.
- Raw gitleaks output, mine candidates, gazetteers, and other cleartext
  provenance stay local. Persisted verification findings contain hashes and
  structural locations only.
- Verification and publisher freshness checks bind the exact manifest, ledger,
  mine candidates, gazetteer, deletion rules/review/approval chain, placeholder
  registry, scanner config, and final corpus bytes. Report self-hashes detect
  corruption but never substitute for a fresh rerun or owner authorization.

Repo-wide rules and evidence standards are in the root `AGENTS.md`.

## iMessage collector

```bash
bun run --cwd packages/corpus-tools corpus:collect:imessage -- \
  --output <private-gitignored-dir> --account-id <slug> \
  --owner-id <id> --owner-display <name>
```

The default source is `~/Library/Messages/chat.db`; the invoking terminal needs
macOS Full Disk Access. Validate the keyed local receipt with
`bun --conditions=eliza-source packages/corpus-tools/src/cli.ts verify-receipt imessage --output <dir> --account-id <slug>`.
