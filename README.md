# awr-evidence-action

A GitHub Action that records a CI run as Agent Work Record (AWR) v0 evidence. It builds one evidence fragment (`kind` `ci_run`) for the current workflow run, with the run attempt as its id, the run URL, the commit the run checked and its result, and checks the fragment against the AWR v0 schema. It then writes the fragment to a file, POSTs it to a tracker that accepts AWR fragments, or both. It has no runtime dependencies and does not need any particular tracker.

## Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `workspace` | yes | | AWR URI of the workspace the work belongs to. |
| `work` | yes | | AWR URI of the work item. |
| `by` | yes | | URI of the agent or person the tracker authenticates the sender as. |
| `claim` | no | `ready_for_review` | The claim the run supports: `ready_for_review`, `done`, `released` or a URI. |
| `result` | no | the job status | `pass`, `fail`, `pending` or `neutral`, or a job status: `success` is `pass`, `failure` is `fail`, `cancelled` and `skipped` are `neutral`. |
| `note` | no | | Short context, left out when empty. |
| `endpoint` | no | | URL to POST the fragment to. It must be `https`, except `http` on localhost. |
| `token` | no | | Bearer token, sent only to `endpoint`. It is masked in the log and never printed. |
| `body` | no | `fragment` | `fragment` sends the bare fragment JSON. `hydrant` sends `{ "requestId", "fragment" }`. |
| `output-file` | no | | Path to write the fragment to. With no `endpoint` and no `output-file`, the fragment goes to `$RUNNER_TEMP/awr-evidence-{run id}-{attempt}.json`. |
| `fail-on-error` | no | `true` | When `false`, a failed send is a warning and the job continues. Bad inputs still fail the step. |

## Outputs

| Output | Meaning |
|---|---|
| `evidence-id` | The evidence id: `{server}/{owner}/{repo}/actions/runs/{run id}/attempts/{attempt}`. |
| `fragment-file` | Absolute path of the fragment file, when one was written. |
| `status` | The HTTP status of the send, when the action sent the fragment. |

## What it sends

```json
{
  "spec": "agent-work-record/v0",
  "workspace": "https://tracker.example.com/w/acme",
  "work": "https://tracker.example.com/w/acme/issues/42",
  "evidence": {
    "id": "https://github.com/acme/app/actions/runs/123456/attempts/1",
    "kind": "ci_run",
    "uri": "https://github.com/acme/app/actions/runs/123456",
    "claim": "ready_for_review",
    "by": "https://tracker.example.com/w/acme/agents/ci",
    "at": "2026-10-17T12:00:00.000Z",
    "subject": { "gitCommit": "3f2a9c1435b35d5f7909a03b9e61584db41b2143" },
    "result": "pass"
  }
}
```

- `id` is the run attempt, so a rerun is new evidence and a repeated send of one attempt collides instead of adding a duplicate. Send one fragment per run attempt and work item.
- `uri` is the run's page.
- `subject.gitCommit` is the pull request's head commit on `pull_request` and `pull_request_target` events, not the merge commit GitHub tests, and `GITHUB_SHA` otherwise.
- `at` is when the step ran.
- With `body: hydrant`, `requestId` is a UUID v5 of the evidence id, so the same attempt always sends the same request id.

The send is retried once after a 429 (waiting for `Retry-After`, at most 60 seconds), a 5xx or a network error. Any other 4xx fails at once with the tracker's message. Redirects are not followed, so the token goes nowhere but `endpoint`. After a successful send, the step logs the tracker's response, cut at 2000 characters.

Pass `token` from a secret. GitHub masks secrets in the log from the start of the job; the action's own mask only starts when its step runs, after the runner has already printed the step's inputs.

If the step runs again in the same attempt with the same inputs and the same `output-file`, it sends the fragment it wrote the first time, `at` included, rather than a new one under the same id.

### The job status

A JavaScript action cannot read the job's status from its environment. The `result` input defaults to the `${{ job.status }}` expression in `action.yml`, which the runner evaluates when the step starts: `success` while every earlier step has passed, `failure` once one has failed. Steps after a failure only run with an `if:` such as `always()`, so put that on the step when you want failures reported:

```yaml
- uses: Background-Craft/awr-evidence-action@<commit>
  if: always()
  with:
    # ...
```

Pass `result` yourself to report something else, such as one step's outcome: `result: ${{ steps.tests.outcome }}`.

## Example: write a fragment file

Works with any tracker, or none. The file can be uploaded as an artifact or sent by a later step.

```yaml
- name: Record the run
  id: awr
  if: always()
  uses: Background-Craft/awr-evidence-action@<commit>
  with:
    workspace: https://tracker.example.com/w/acme
    work: https://tracker.example.com/w/acme/issues/42
    by: https://tracker.example.com/w/acme/agents/ci
    output-file: awr-fragment.json

- uses: actions/upload-artifact@v7
  if: always()
  with:
    name: awr-fragment
    path: ${{ steps.awr.outputs.fragment-file }}
```

To send the bare fragment to a tracker instead, add `endpoint` and `token`:

```yaml
    endpoint: https://tracker.example.com/awr/fragments
    token: ${{ secrets.TRACKER_TOKEN }}
```

## Example: Hydrant

Hydrant takes fragments at `POST /api/agent/issues/{issue id}/work-record/fragments`, from an agent key with write access, with the `hydrant` body. It accepts a fragment only when `by` is the key's own agent id and `workspace` and `work` name that issue.

```yaml
- name: Send the run to Hydrant
  if: always()
  uses: Background-Craft/awr-evidence-action@<commit>
  with:
    workspace: https://hydrant.dev/w/<workspace id>
    work: https://hydrant.dev/w/<workspace id>/issues/<issue number>
    by: https://hydrant.dev/w/<workspace id>/agents/<agent connection id>
    endpoint: https://hydrant.dev/api/agent/issues/<issue id>/work-record/fragments
    body: hydrant
    token: ${{ secrets.HYDRANT_AGENT_KEY }}
```

Finding the values:

- `workspace` and `work` are the `workspace` and `work.id` of the issue's record from Hydrant's `read_work_record` MCP tool. The workspace id and issue number in them never change when the workspace is renamed.
- `by` is the agent key's id under the workspace. If it is wrong, Hydrant's refusal names the id it expects.
- The endpoint takes the issue's id (a UUID), which `get_issue` returns, not its number.

A repeated send of the same attempt with the same fragment replays Hydrant's first receipt. Hydrant answers 429 with `Retry-After` past its per-minute fragment budgets, which the action waits for once.

## The spec

The AWR v0 spec is to be published at hydrant.dev/agent-work-record and in a public spec repository. Until then, `vendor/awr-spec/` holds an unchanged copy of the spec, its JSON Schema, its examples and its dependency-free `validate.mjs`, from `docs/spec/` of the Hydrant repository at commit `2c9bfbe783b8449487c7e2b092f347859d26dbdf`. `vendor/awr-spec.sha256` lists the checksum of every file there, and CI checks it.

## Development

Node 24, nothing to install.

```sh
node --test 'test/*.test.mjs'                 # unit tests
node vendor/awr-spec/validate.mjs             # the spec's own check of its examples
node test/validate-fragment.mjs fragment.json # a fragment through the vendored validator
```

CI runs those, then runs the action on itself in file mode and in post mode against `test/mock-receiver.mjs`, which checks the bearer header and both body shapes and answers 429 once before 200.

## License

Apache-2.0. See [LICENSE](LICENSE).
