# External API mock validation

The app's keyless UI-smoke lane replaces external-provider calls with
hand-authored `page.route` fixtures. Without a tie to the real API, those
fixtures can silently drift. Source comments in the form
`external-api-mock: <provider-id>` identify the live fixture inventory;
`test/external-api-mock-validation.test.ts` requires each tag to have real
validation artifacts or a reasoned exemption.

## The two boundaries

An external API view plugin has two contract boundaries:

1. **UI ⇄ BFF** — the DTO consumed by the view and emulated by the smoke fixture.
2. **BFF ⇄ provider** — the plugin route handler that parses the real provider
   response into that DTO.

A fixture is validated when the real BFF parser produces the expected DTO from
a recorded provider response and a live check can detect drift from that
recording.

## Validated pattern

1. `src/__fixtures__/<api>-real.recorded.json` captures a real provider response
   with its source and capture date.
2. `src/__fixtures__/contract.ts` validates each BFF DTO at runtime.
3. `src/routes.contract.test.ts` replays the recording through the real parser
   with an injected provider client.
4. `src/routes.real.test.ts` is environment-gated and checks the live provider
   for drift.
5. The UI-smoke fixture produces the same contract-shaped DTO and carries an
   `external-api-mock` source tag.

Provider calls need an injectable client for deterministic replay. Plugins
without that seam require the refactor before they can move out of exemption.

## Current source-tagged providers

| Provider | Tier | Evidence or boundary |
|---|---|---|
| Polymarket | **validated** | `plugin-polymarket/src/routes.{contract,real}.test.ts` plus recorded fixtures |
| Hyperliquid | **validated** | `plugin-hyperliquid/src/routes.{contract,real}.test.ts` plus recorded fixtures |
| CoinGecko | **validated** | `plugin-wallet/src/routes/wallet-market-overview.{contract,real}.test.ts` plus recorded fixtures |
| Browser location/weather | **exempt** | ipapi and Open-Meteo are called directly; there is no repository-owned provider parser |
| Shopify | **exempt** | Retained provider-shaped DTOs have no current recorded replay and live-drift harness |
| Wallet RPC | **exempt** | EVM, Solana, token-balance, and NFT providers are aggregated behind wallet DTOs |
| ElevenLabs | **exempt** | The smoke fixture is binary TTS; the JSON voices contract still needs recorded evidence |
| Google | **exempt** | Calendar, Gmail, Drive, and YouTube need OAuth-gated recordings per surface |

## Source-derived authority

The validation test discovers provider tags in UI-smoke source and enforces:

1. every discovered provider is classified exactly once as validated,
   contract-tested, or explicitly exempt;
2. stale classifications and empty exemption reasons fail;
3. every validated provider keeps its contract, fixture, and live-drift
   artifacts; and
4. every contract-tested provider keeps its recorded-contract artifact.

To advance a provider, capture a real response, add the replay test, then add the
gated live-drift test and update its classification.
