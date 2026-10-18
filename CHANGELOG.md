# Changelog

## Unreleased

- First version. Builds one Agent Work Record v0 evidence fragment (`kind` `ci_run`) for the current run attempt, checks its shape against the vendored AWR v0 schema, writes it to a file and, given `endpoint`, POSTs it as the bare fragment or as Hydrant's `{ requestId, fragment }` body. `requestId` is a UUID v5 of the work URI and the evidence id.
- One retry on 429 (honoring `Retry-After`, at most 60 seconds), 5xx or a network error. `fail-on-error: false` turns a failed send into a warning.
- Vendored spec from hydrant-0926 `docs/spec/` at `2c9bfbe783b8449487c7e2b092f347859d26dbdf`.
- Tracker text in the log (the retry line and the response) is escaped, so it cannot add lines or workflow commands, and the token is redacted from both.
