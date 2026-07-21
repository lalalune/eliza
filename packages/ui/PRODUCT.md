# Product

## Register

product

## Users

Mainstream consumers using a personal AI agent (Eliza) on web, desktop, or
mobile. Most are not developers: they want an assistant that chats, remembers,
handles voice, and helps with daily tasks without needing to understand the
runtime. The shared UI also serves local-only and Eliza Cloud deployments, so
its components cannot assume technical fluency or one hosting topology.

## Product Purpose

Provide the reusable interface system for a single, trustworthy home for an AI
agent: chat, voice, notifications, settings, apps, and automations. Components
should feel like a natural extension of the user's device, remain coherent
across surfaces, and make agent capabilities understandable in plain language.

## Brand Personality

Warm, human, approachable. Three words: **calm, warm, present.** The agent
should read as a companion with presence, not a tool with a feature list.
User-facing language stays friendly and avoids implementation jargon such as
"runtime," "plugin," and "provider."

## Anti-references

- Generic SaaS admin dashboards built from dense tables, metric tiles, and
  repetitive card grids. This is a companion interface, not an enterprise
  console.
- Cold AI-tool chrome: heavy borders, gray-on-gray panels, decorative gradients,
  or technical vocabulary used as visual flavor.
- Reference target: Apple-native interaction quality—clean, warm, restrained,
  and physically credible rather than decorative.

## Design Principles

- **Feels native, not webby.** Use platform-appropriate spacing, motion, and
  affordances instead of stretching one desktop layout across every viewport.
- **Plain language over jargon.** Internal runtime concepts never define the
  user-facing information architecture.
- **Presence over dashboard.** Favor calm conversational surfaces and clear
  task progress over dense administration patterns.
- **Cloud-optional, never cloud-assuming.** Components remain complete and
  understandable for both local and Cloud-backed agents.
- **Warmth through restraint.** Tone, typography, and purposeful motion carry
  warmth; decorative chrome does not.
- **Consistency over surprise.** Shared controls expose the same states,
  affordances, and interaction vocabulary everywhere they appear.

## Accessibility & Inclusion

WCAG AA is the baseline: at least 4.5:1 body-text contrast, visible focus
states, complete keyboard access, reduced-motion alternatives, and no state
communicated by color alone. Interactive targets must remain usable on touch
devices and at increased text sizes.
