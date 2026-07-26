# Issue #13567 — iOS device lane: automate development-profile minting (App Store Connect API)

## What this delivers (task 1 — the headline "development-profile minting")

`packages/app/scripts/ios-device-provision.mjs` + `ios:device:provision` npm script.

Given the ASC key triplet already used by `apple-store-release.yml`
(`APP_STORE_API_KEY_ID` / `APP_STORE_API_ISSUER_ID` / `APP_STORE_API_KEY_P8`),
it non-interactively — no Xcode account session:

1. builds a short-lived **ES256** App Store Connect JWT from the `.p8` (raw
   `ieee-p1363` r‖s signature, 20-min TTL, `aud: appstoreconnect-v1`);
2. **registers** the device UDID (`GET`/`POST /v1/devices`) — idempotent;
3. resolves a **DEVELOPMENT certificate** (`/v1/certificates`), failing fast if none;
4. **ensures a bundle id** for the app + every appex (`GET`/`POST /v1/bundleIds`) — idempotent;
5. **mints or reuses a device-scoped development profile** per bundle id
   (`IOS_APP_DEVELOPMENT`; dev profiles are immutable and ASC names are unique,
   so an existing same-name profile is reused only when it already covers the
   requested bundle/device/certificate set; otherwise the run fails without
   deleting the last usable profile);
6. **downloads** each profile's base64 `profileContent` into
   `~/Library/MobileDevice/Provisioning Profiles/<uuid>.mobileprovision` — exactly
   where `ios-device-deploy.mjs` `discoverProfiles()` looks.

Bundle ids come from `--bundle-id` flags or are discovered from
`--product <App.app>/PlugIns/*.appex` (`CFBundleIdentifier` via `plutil`), so the
5 appexes (widgets, DeviceActivity ×2, WebsiteBlocker, ElizaKeyboard) get
profiles and `ios:device:deploy` no longer needs `--skip-appexes`.

`--dry-run` proves the JWT + bundle-id resolution without mutating the ASC team,
and now fails if neither `--bundle-id` nor a valid `--product` resolves at least
one bundle id.

## Test evidence (real run on this host)

The API flow, JWT, credential handling, and profile writing are pure functions
with an injectable `fetchImpl`, unit-tested without real credentials or the
network:

```
$ bunx vitest run packages/app/scripts/ios-device-provision.test.mjs
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

Coverage: credential fail-fast (names every missing var; inline PEM vs .p8 path);
**real ES256 JWT** — asserts the header/claims and that the signature *verifies*
against the generated EC public key (`crypto.verify`, `ieee-p1363`); non-EC key
rejected; ASC error bodies surfaced verbatim (fail fast, no swallow); device /
bundle-id **idempotency** (existing → reused, no POST); profile minting with
the correct `IOS_APP_DEVELOPMENT` + device/cert relationships; reuse of an
existing valid same-device profile without DELETE/POST; fail-closed handling for
an invalid same-name profile; fail-closed handling for expired/inactive
same-name profiles; device-scoped profile names that prevent provisioning device
B from deleting device A's profile; base64 `profileContent` decoded to
`<uuid>.mobileprovision`; appex
`CFBundleIdentifier` discovery (de-duped); dry-run/bundle validation that fails
on zero resolved bundle ids; and the full `provision()` flow writing a profile
per bundle id with the bearer JWT on every request.

The verifier-reported dry-run false-green now fails:

```
$ APP_STORE_API_KEY_ID=KID APP_STORE_API_ISSUER_ID=ISS APP_STORE_API_KEY_P8=<p8> \
  bun run --cwd packages/app ios:device:provision -- --device TEST --dry-run
$ node scripts/ios-device-provision.mjs --device TEST --dry-run
[provision] ios:device:provision: no bundle ids resolved (pass --bundle-id or --product with appexes).
error: script "ios:device:provision" exited with code 1
# exit 1
```

The wired package script succeeds when a bundle id is supplied:

```
$ APP_STORE_API_KEY_ID=KID APP_STORE_API_ISSUER_ID=ISS APP_STORE_API_KEY_P8=<p8> \
  bun run --cwd packages/app ios:device:provision -- --device TEST --bundle-id ai.elizaos.app --dry-run
$ node scripts/ios-device-provision.mjs --device TEST --bundle-id ai.elizaos.app --dry-run
[provision] dry-run — device TEST, 1 bundle id(s):
  - ai.elizaos.app
# exit 0
```

## Acceptance criteria mapping

- ✅ "development-profile minting via the ASC API, no Xcode UI" — the script,
  unit-verified above.
- ⏳ Live acceptance ("with ASC creds set, `ios:device:provision --device <id>` +
  `ios:device:deploy` (no `--skip-appexes`) installs the full app with all 5
  appexes on a fresh device") — **needs real ASC credentials + a registered
  physical device**, which this headless CI host lacks. That is the
  Needs-agent-verify step (a device-equipped/credentialed runner).

## Scoped follow-ons (from the issue, NOT in this PR)

- Task 2: codify the runner **graft-signing** recipe as the default device path
  in `ios-device-capture.mjs` (build with `CODE_SIGNING_ALLOWED=NO` → graft-sign
  from a discovered wildcard/xctrunner profile) so the runner rebuilds without an
  Xcode session — depends on a profile existing (this script) and needs device
  verification.
- Task 3: flip non-`--skip-appexes` back to the deploy default once appex
  profiles mint on the lane.

## N/A with reason

- Live `ios:device:provision` run against the real ASC team + device
  registration + on-device install — **N/A here**: no ASC credentials and no
  physical iOS device on this host. Proven by the 25-test contract suite +
  inspection; the live run is the device-lane verification step.
