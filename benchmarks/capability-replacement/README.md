# Capability replacement benchmark

This is the deterministic mutation layer for the v0.12 release proof. `legacy.mjs` is a privacy-safe command harness for the AIR-owned legacy capability; `candidate.mjs` is an ordinary TypeScript/JavaScript replacement authored by an external coding agent and imports no AIR runtime.

The automated gate creates a legacy baseline in memory, runs the equivalent candidate 20 times, and requires every entry in `mutants.json` to produce a behavioral or missing-observation result. The committed material contains no payload captures or credentials.

This command harness does **not** complete the separate Spring/PostgreSQL live gate. v0.12 remains unreleased until that live harness and the HMCTS replacement proof pass.
