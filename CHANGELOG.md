# Changelog

## 2.0.0 — prepared locally, 2026-11-26

**Breaking: every tool result now opens with a fixed label block.** `content[0]` is the text `[UNTRUSTED THIRD-PARTY CONTENT] ...`, saying the next block came from the upstream source and is data, never instructions; the data that used to be `content[0]` is now `content[1]`, unchanged. A program that parses results should skip the block whose text starts with `[UNTRUSTED THIRD-PARTY CONTENT]`. Every tool also declares MCP tool annotations (read-only, non-destructive, idempotent, open world).

`NYC_APP_TOKEN` holding a space, line break or control character is refused with a message that names the variable and never quotes it. Before this, Node's fetch rejected the header and its error, which quotes the whole value, was returned to the model.

## 1.2.0 — prepared locally, 2026-11-04

Add opt-in dated building activity timelines with per-source coverage and original record links. Building snapshots and multi-address comparisons are available in the separate local Civic Workbench.

Includes the preceding local correctness fixes and regression coverage. This version has not been published or deployed. See GAUNTLET.md for verification requirements.
