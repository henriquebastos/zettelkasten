# Claude Code integration — not implemented

This directory is a harness brief, not an integration. An agent running inside Claude Code must
first investigate supported hooks, stable native run/thread identifiers, parent provenance, and
title or metadata APIs.

Completion requires: use only `claude:<stable-native-run-or-thread-id>` opaque keys; preserve exact
opaque `parentKey`; create ancestors parent-first; rely on service idempotency; never allocate or
persist a local fallback; validate returned lineage; and show the returned address through the
harness's supported title/metadata surface without making display text identity. Tests must cover
roots, children, retries, concurrency, missing configuration before fetch, and service failure.
