# Changelog

## v0.1.0

- First version. Builds one Agent Work Record v0 evidence fragment (`kind` `ci_run`) for the current run attempt, checks its shape against the vendored AWR v0 schema, writes it to a file and, given `endpoint`, POSTs it as the bare fragment or as Hydrant's `{ requestId, fragment }` body. `requestId` is a UUID v5 of the work URI and the evidence id.
- One retry on 429 (honoring `Retry-After`, at most 60 seconds), 5xx or a network error. `fail-on-error: false` turns a failed send into a warning.
- Vendored spec from [Background-Craft/agent-work-record](https://github.com/Background-Craft/agent-work-record) `spec/` at tag `v0.1`.
- Every log line, tracker text included, is redacted and then escaped, so it cannot add lines or workflow commands and never prints the token in escaped form.
- With `body: hydrant`, only an identical retry replays Hydrant's receipt. A separate second send for the same attempt and work item has a new `at` and is refused with 409 without a duplicate.
