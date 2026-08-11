# Pi integration — not implemented

This directory is a harness brief, not an integration. An agent running inside Pi must first
investigate supported lifecycle hooks, stable native session IDs, parent provenance, and title or
metadata APIs.

Completion requires: use only `pi:<stable-native-session-id>` opaque keys; preserve exact opaque
`parentKey`; create ancestors parent-first; rely on service idempotency; never allocate or persist a
local fallback; validate returned lineage; and show the returned address through Pi's supported
title/metadata surface without making display text identity. Tests must cover roots, children,
retries, concurrency, missing configuration before fetch, and service failure.
