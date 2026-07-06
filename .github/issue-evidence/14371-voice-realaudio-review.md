# Issue #14371 Voice Real-Audio Evidence

Generated on 2026-07-06 from the `chromium-voice-mic` Playwright lane.

## Automated Checks

- `bun run --cwd packages/ui test -- src/voice/local-asr-capture.test.ts src/state/persistence-vad-auto-stop.test.ts src/voice/voice-capture-factory.test.ts src/components/shell/useShellVoiceOutput.test.tsx src/components/shell/__tests__/useShellController.test.tsx`
  - 5 files, 93 tests passed.
- `bun run --cwd packages/ui test -- src/components/shell/ContinuousChatOverlay.test.tsx`
  - 1 file, 157 tests passed.
- `E2E_RECORD=1 bun run --cwd packages/app test:e2e test/ui-smoke/voice-realaudio.spec.ts`
  - 5 tests passed.
  - 1 test skipped: live Railway voice round-trip requires `ELIZA_VOICE_LIVE_RAILWAY=1` plus a live LLM key.
- `bun run --cwd packages/app test:e2e test/ui-smoke/all-views-aesthetic-audit.spec.ts --project=audit-app --grep "builtin-(inventory|fine-tuning|background)|plugin-(model-tester|wallet|training)-gui"`
  - 24 viewport findings: `broken=0`, `needs-work=0`, `needs-eyeball=0`, `good=24`.
- `bun run --cwd packages/app audit:app`
  - 365 Playwright checks passed.
  - Computed verdicts: `broken=0`, `needs-work=0`, `needs-eyeball=25`, `good=339`.
  - Remaining hover probe failures are pre-existing soft signals in transcripts/finances; no overlay-clearance failures remain.
- `node scripts/evidence-review/generate.mjs --no-open --out=.github/issue-evidence/14371-review --source=.github/issue-evidence --ocr=auto --max-artifacts=100 --max-images=20`
  - Artifacts: 17 total, 6 screenshots, 5 videos.
  - OCR engine: `tesseract.js package`.
  - OCR completed for 6/6 screenshots with 0 failures.
  - Image heuristics reported 0 screenshot issues.
  - All app-state screenshots reported `blueRatio: 0`.
- `bun run voice:matrix -- --platform web.live-railway.roundtrip --out .github/issue-evidence/14371-voice-matrix`
  - The new `web.live-railway.roundtrip` cell was selected.
  - Probe result: `skip`, reason `set ELIZA_VOICE_LIVE_RAILWAY=1 on a runner with live Railway voice services`.
  - Command wired by the cell: `bun run --cwd packages/app test:e2e test/ui-smoke/voice-realaudio.spec.ts --grep @live-railway`.

## Visual Evidence

- `14371-web-roundtrip-selftest.png` / `.webm`: self-test shows `overall: pass`, ASR/send/TTS all pass, transcript `what time is it`, and WER 0 in the recorded fake-device capture lane.
- `14371-barge-in-finished.png` / `.webm`: transcription starts during spoken local TTS and the audio source is stopped/disconnected.
- `14371-mic-denied-error-state.jpg` / `.webm`: microphone denial renders a visible error notice, returns the mic to `talk`, and posts no ASR capture.
- `14371-initial-silence-clean-stop.jpg` / `.webm`: silent capture auto-stops and returns to a clean composer with no empty user or assistant turn.
- `14371-cloud-tts-drop-error-state.jpg`: cloud TTS transport failure renders a distinct `Cloud voice unavailable` alert above the composer.
- `14371-cloud-tts-recovered.jpg` / `14371-cloud-tts-recovery.webm`: the next voice turn recovers, starts Web Audio playback, and clears the alert.

## Manual Review Notes

- The self-test page is readable and shows the actual captured transcript and pass states.
- The mic-denied toast is visually distinguishable and does not leave recording active.
- The initial-silence state has no phantom chat content.
- A rebase rerun exposed that the TTS error alert path referenced an undefined
  shadow token and fell into the error boundary; the overlay test now forces
  `controller.ttsError`, and the refreshed Playwright screenshot shows the
  inline alert instead of the boundary.
- The first TTS-error screenshot exposed low contrast in the inline alert; the alert now uses the destructive token foreground/background pair and is readable in the refreshed evidence.
- The live Railway lane is implemented and matrix-gated, but it was not executed here because the required live env and LLM credentials are absent.
