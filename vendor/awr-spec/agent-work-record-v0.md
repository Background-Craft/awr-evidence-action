# Agent Work Record (AWR), v0 (draft)

Status: draft for native #681, with the additive [v0.1](#v01-additions) from native #710. Nothing here is published, licensed or promised to anyone outside the repository.

## What this is

AI agents now write, review and ship software. The person responsible needs three answers about any piece of agent work:

1. **Who was allowed to do this?** Which agent, acting for which person, with what permission, until when.
2. **What shows it was done?** The pull request, the CI run, the screenshot, the review.
3. **Who said it was good?** Which person accepted or rejected it, and on what basis.

This spec is one small JSON document per unit of work that answers all three, plus an append-only audit trail of how it happened. A tracker, CI system or agent runner should be able to write and read it in an afternoon. Hydrant is the reference implementation in a later milestone; the [Hydrant mapping](#hydrant-mapping) shows how far it is today.

The spec covers five areas: [agent identity](#1-agent-identity), [grants](#2-grants), [evidence](#3-evidence), [sign-off](#4-sign-off) and [audit events](#5-audit-events). A system that does not own the work, such as a CI service, can send a single piece of evidence or a single event as a [fragment](#fragments).

## Files

| File | What it is |
|---|---|
| `agent-work-record-v0.md` | This document. |
| [agent-work-record-v0.schema.json](agent-work-record-v0.schema.json) | JSON Schema, draft 2020-12. |
| [examples/end-to-end.json](examples/end-to-end.json) | A full record: grant, work, evidence, sign-off, audit trail. |
| `examples/invalid/*.json` | Nine records that must fail, one broken rule each. |
| `examples/v0.1/*.json` | One record for each [v0.1 addition](#v01-additions). |
| `examples/fragments/*.json` | Two [fragments](#fragments): one evidence item, one event. |
| `examples/fragments/invalid/*.json` | Two fragments that must fail. |
| `examples/hydrant/*.json` | Records Hydrant exported from seeded issues (#699): a full issue, a legacy-only issue, one with merged fragments and one that needs v0.1 (`kept.json`, #710). |
| [validate.mjs](validate.mjs) | The check. No dependencies. |

## Design rules

- **JSON only.** No server, registry, database or key infrastructure is needed to write or read a record.
- **Identifiers are URIs.** Use a stable URL your system already serves (`https://tracker.example.com/w/acme/agents/builder`) or a `urn:uuid:` value. A reader compares identifiers as exact strings. The check only requires a scheme (`https:`, `urn:`) and no whitespace; it does not parse full RFC 3986 syntax.
- **Times are RFC 3339** with a zone (`2026-10-14T09:00:00Z`).
- **Append-only.** Agents, grants, evidence and sign-offs are never edited. A change is a new event (a grant ends with a `grant.revoked` event, not by editing the grant).
- **People decide; agents act.** A sign-off always names a person. An agent can carry it only under a grant from that person.
- **Signing is optional in v0.** A record or a piece of evidence may be signed with an in-toto/DSSE envelope. See [Signing](#signing-optional).
- **Unknown versions and event types.** A reader refuses a record whose `spec` it does not know. A reader ignores events whose `type` it does not know, the same as unknown fields.
- **Unknown fields.** Readers MUST ignore fields they do not know, so a v0 reader can still read a later version. v0 writers MUST NOT emit fields this spec does not define; extensions use URI values where the spec allows them (custom actions and claims), not new keys. `validate.mjs` is the writer conformance check, so it is strict and the schema keeps `additionalProperties: false`. A reader must not reject a record just because that strict check fails on an unknown field.

In the tables, "Req" means required.

## The record

<!-- validate: work -->
```json
{
  "id": "https://tracker.example.com/w/acme/issues/42",
  "title": "Add CSV export to the reports page"
}
```

| Field | Type | Req | Meaning |
|---|---|---|---|
| `spec` | string, `agent-work-record/v0`, or `agent-work-record/v0.1` for a record that uses a [v0.1 addition](#v01-additions) | yes | Version of this spec. |
| `id` | URI | yes | This record. |
| `workspace` | URI | yes | The workspace or organization every agent and person here belongs to. |
| `work` | object | yes | The unit of work: `id` (URI, req) and `title` (string, req). The example above. |
| `agents` | array of [Agent](#1-agent-identity) | yes | Every agent that acted. |
| `grants` | array of [Grant](#2-grants) | yes | Every permission an agent used. |
| `evidence` | array of [Evidence](#3-evidence) | yes | Everything offered to support a claim. |
| `signoffs` | array of [Sign-off](#4-sign-off) | yes | Every decision a person made. |
| `events` | array of [Event](#5-audit-events), at least one | yes | The audit trail. |
| `people` | array of [listed person](#people-who-only-acted), v0.1 | no | People the record names only because they moved the work or made a claim. |

A **person** is `{ "id": URI, "name"?: string }`. `id` is required. In v0 people have no list of their own: they appear where they act (`on_behalf_of`, `granted_by`, sign-off `by`). v0.1 adds `people` for anyone else who moved the work or made a claim.

A **claim** is what someone says about the work. v0 defines three: `ready_for_review`, `done` and `released`. Any other claim must be a URI you control.

## 1. Agent identity

Which agent this is and which person it works for.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | URI | yes | Stable identifier of the agent's connection or identity. Not a secret. |
| `name` | string | yes | Display name, such as "Builder". |
| `on_behalf_of` | person | yes | The person responsible for the agent. Its permissions come from this person. |
| `client` | string | no | The software running the agent, such as `claude-code` or `codex`. |
| `model` | string | no | The model, such as `claude-opus-5-5`. |

<!-- validate: agent -->
```json
{
  "id": "https://tracker.example.com/w/acme/agents/builder",
  "name": "Builder",
  "on_behalf_of": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
  "client": "claude-code",
  "model": "claude-opus-5-5"
}
```

The workspace is the record's `workspace`. An agent that works in two workspaces has two identities. The `agent.connected` and `agent.revoked` events say when the identity started and stopped.

## 2. Grants

Who allowed an agent to do what, on which work, until when.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | URI | yes | This grant. |
| `agent` | URI | yes | The agent's `id`. |
| `granted_by` | person | yes | Who allowed it. |
| `actions` | array of action, at least one | yes | What the agent may do. |
| `excludes` | array of string | no | Things the person reserved, in words ("production data changes"). Readers show them; v0 does not interpret them. |
| `work` | URI | no | Limits the grant to this work. Leave it out for a workspace-wide grant. |
| `issued_at` | timestamp | yes | When it starts. |
| `expires_at` | timestamp | no | When it ends on its own. Leave it out for no expiry. |
| `note` | string | no | The person's own words, quoted. |

Actions defined in v0: `read`, `write`, `open_pull_request`, `merge`, `release`, `sign_off`. Changing code is `write`; there is no separate implement action. Any other action must be a URI. `sign_off` lets the agent record a decision for the person who granted it (see [Sign-off](#4-sign-off)).

<!-- validate: grant -->
```json
{
  "id": "urn:uuid:0b6c9f1a-2d3e-4f50-8a61-7b8c9d0e1f20",
  "agent": "https://tracker.example.com/w/acme/agents/builder",
  "granted_by": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
  "actions": ["read", "write", "open_pull_request"],
  "excludes": ["production data changes", "new paid infrastructure"],
  "work": "https://tracker.example.com/w/acme/issues/42",
  "issued_at": "2026-10-14T09:01:00Z",
  "expires_at": "2026-10-15T09:01:00Z",
  "note": "Go ahead on #42 and open a PR. Do not merge."
}
```

A grant is live from `issued_at` until the first of `expires_at` and its `grant.revoked` event. v0 records permission; it does not enforce it. The record rules check that an agent acted inside some live grant, and that a sign-off carried by an agent has a `sign_off` grant. No other action is checked: a record does not prove that an agent which merged held `merge`. Enforcement stays with the system that issued the credential (an OAuth scope, an API key, a branch rule).

## 3. Evidence

Something offered to support a claim.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | URI | yes | This piece of evidence. |
| `kind` | one of `pull_request`, `ci_run`, `test_output`, `screenshot`, `review`, `summary`, `attestation`, `other` | yes | What it is. `summary` is a written account of what changed and how to check it. `attestation` points to a signed envelope. |
| `uri` | URI | yes | Where to see it. |
| `claim` | claim | yes | The claim it supports. |
| `by` | URI | yes | The agent or person who added it. |
| `at` | timestamp | yes | When it was added. |
| `subject` | digest set | no | The commit or artifact this evidence is about, such as `{ "gitCommit": "<40 hex>" }`. A CI run or review of one head says nothing about the next. |
| `result` | one of `pass`, `fail`, `pending`, `neutral` | no | For runs and reviews. |
| `digest` | digest set | no | Hash of the content at `uri` itself, usually `{ "sha256": "<64 hex>" }`, so a reader can tell if it changed. |
| `note` | string | no | Short context, such as the commit the run checked. |

<!-- validate: evidence -->
```json
{
  "id": "urn:uuid:3e9f2c4d-5061-4283-9d94-0e1f20314253",
  "kind": "ci_run",
  "uri": "https://github.com/acme/app/actions/runs/123456789",
  "claim": "ready_for_review",
  "by": "https://tracker.example.com/w/acme/agents/builder",
  "at": "2026-10-14T11:20:00Z",
  "subject": { "gitCommit": "3f2a9c1435b35d5f7909a03b9e61584db41b2143" },
  "result": "pass",
  "note": "All checks at head 3f2a9c1."
}
```

A **digest set** uses in-toto DigestSet names: `sha256` (64 lowercase hex) and `gitCommit` (40 or 64 lowercase hex). It has at least one of them and no other keys.

Evidence points; it does not copy. Logs, images and diffs stay where they are. A record stays small and holds no secrets.

## 4. Sign-off

A person's decision about a claim, and what they based it on.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | URI | yes | This decision. |
| `by` | person | yes | Who decided. Always a person, never an agent. |
| `via` | URI | no | The agent that recorded it for them. Needs a live grant with `sign_off` from `by`. |
| `decision` | one of `accept`, `reject`, `abstain` | yes | `abstain` means "not mine to judge" and counts as neither. |
| `claim` | claim | yes | The claim decided on, usually `done`. |
| `subject` | digest set | no | The exact commit or artifact the person accepted. |
| `evidence` | array of evidence `id` | yes | What the person relied on. May be empty, which says plainly that they relied on nothing recorded. |
| `at` | timestamp | yes | When. |
| `note` | string | no, but required for `reject` in v0 | The reason, in the person's words. v0.1 keeps a rejection whose reason is missing. |
| `sign_off_grant` | `false`, v0.1 | no | Says `via` recorded this without a live `sign_off` grant from `by`. See [v0.1](#sign-offs-recorded-without-a-grant). |
| `unlisted_evidence` | array of [evidence snapshot](#cited-evidence-no-longer-listed), v0.1 | no | Cited evidence that is no longer listed, as it stood when the person decided. |

<!-- validate: signoff -->
```json
{
  "id": "urn:uuid:8de47192-a5b6-47d8-a2e9-536475869708",
  "by": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
  "via": "https://tracker.example.com/w/acme/agents/builder",
  "decision": "reject",
  "claim": "done",
  "evidence": ["urn:uuid:4fa03d5e-6172-4394-8ea5-1f2031425364"],
  "at": "2026-10-14T15:00:00Z",
  "note": "The export button is missing on mobile. See the screenshot."
}
```

The latest sign-off from a person on a claim is their current answer. An earlier one stays in the record.

A sign-off with `subject` accepted that exact content. A later push makes it stale: a reader that sees newer work (a pull request head or build that differs from `subject`) shows the sign-off as stale rather than current. A sign-off without `subject` accepted the work in general, and a reader cannot tell whether it is still fresh.

## 5. Audit events

The append-only trail of everything above, in order.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `seq` | integer, from 1 | yes | Position. 1, 2, 3 with no gaps. |
| `at` | timestamp | yes | When. Never earlier than the event before. |
| `actor` | URI | yes | The person or agent who did it. |
| `type` | event type | yes | What happened (below). |
| `ref` | URI | yes | The agent, grant, evidence, sign-off or work it is about. |
| `claim` | claim | for `claim.made` | The claim made. |
| `note` | string | no | Short context, such as "Ready to In Progress". |

Event types: `agent.connected`, `agent.revoked`, `grant.issued`, `grant.revoked`, `work.status_changed`, `evidence.added`, `claim.made`, `signoff.recorded`.

<!-- validate: event -->
```json
{
  "seq": 12,
  "at": "2026-10-14T12:15:00Z",
  "actor": "https://tracker.example.com/w/acme/agents/builder",
  "type": "claim.made",
  "ref": "https://tracker.example.com/w/acme/issues/42",
  "claim": "done"
}
```

A writer adds events and never rewrites them. A reader that receives a newer copy of a record checks that the older events are an unchanged prefix.

## Fragments

The record is the main document. A system that does not own the work item, such as a CI service or an agent runner, can instead send a **fragment**: exactly one evidence item or one event, with just enough context for the tracker that owns the work to merge it.

| Field | Type | Req | Meaning |
|---|---|---|---|
| `spec` | string, always `agent-work-record/v0` | yes | Version of this spec. |
| `workspace` | URI | yes | The workspace the work belongs to. |
| `work` | URI | yes | The work item's `id`. |
| `evidence` | [Evidence](#3-evidence) | one of these two | The evidence item. |
| `event` | [Event](#5-audit-events) without `seq` or `at`; `type` is `work.status_changed` or `claim.made` | one of these two | The event. |

<!-- validate: fragment same-as=examples/fragments/event.json -->
```json
{
  "spec": "agent-work-record/v0",
  "workspace": "https://tracker.example.com/w/acme",
  "work": "https://tracker.example.com/w/acme/issues/42",
  "event": {
    "actor": "https://tracker.example.com/w/acme/agents/builder",
    "type": "claim.made",
    "ref": "https://tracker.example.com/w/acme/issues/42",
    "claim": "ready_for_review",
    "note": "Sent by Builder's agent runner after the nightly suite passed."
  }
}
```

Merge rules for the tracker:

1. The tracker authenticates the sender as the event's `actor` or the evidence's `by`, or as a system that agent or person authorized. Otherwise it refuses the fragment.
2. A fragment whose `workspace` or `work` the tracker does not own is refused.
3. A fragment carries only `work.status_changed` or `claim.made` events. Creating events come only from the tracker that owns the record, and revocations come from whoever issued the grant or connection, inside that tracker.
4. The tracker assigns the event's `seq` and `at` when it merges and appends it after the last event it holds, so the audit trail says when the tracker recorded it. A late fragment therefore still merges. Evidence keeps its own `at` (when it was produced), which may be earlier than its `evidence.added` event.
5. For an evidence fragment, the tracker adds the `evidence.added` event itself, with the evidence's `by` as actor.
6. Ids must be unique: an evidence id that already exists in the record is refused, not overwritten.
7. The record rules (creating events, live grants, references) apply to the merged record, not to the fragment alone, and grant liveness is judged at merge time. A fragment merged after the agent's grant has ended is refused, so senders should send promptly.

`validate.mjs` checks fragments for shape only. This block equals [examples/fragments/event.json](examples/fragments/event.json); an evidence fragment is in [examples/fragments/evidence.json](examples/fragments/evidence.json). Both fit the [end-to-end example](#end-to-end-example): Builder's agent runner, authenticated as Builder, sends them at 13:45, after event 12 and while Builder's grant is live, and they would merge as events 13 (`evidence.added`) and 14 (`claim.made`) of the record as it stood then, with events 1 to 12.

## Record rules

JSON Schema checks shape. These rules need the whole record, and `validate.mjs` checks every one:

1. Every `id` is unique within the record. A person is never also an agent.
2. Every reference resolves: grant `agent`, evidence `by`, sign-off `evidence` and `via`, event `actor` and `ref`. A grant's `work`, if set, is this record's work. An event's `ref` names the kind of object its type is about: `agent.*` an agent, `grant.*` a grant, `evidence.added` evidence, `signoff.recorded` a sign-off, `work.status_changed` and `claim.made` the work.
3. Events are numbered 1, 2, 3 with no gaps, and their times never go backwards.
4. Every agent, grant, evidence and sign-off has its creating event (`agent.connected`, `grant.issued`, `evidence.added`, `signoff.recorded`), and that event's `actor` is who the object says made it: the agent's `on_behalf_of`, the grant's `granted_by`, the evidence's `by`, and the sign-off's `by` or `via`. An agent cannot record a sign-off as a person without naming itself in `via`.
5. Every event by an agent falls inside a live grant for that agent, and before any `agent.revoked` for it.
6. A sign-off with `via` needs a live `sign_off` grant from the person in `by` to that agent. In v0.1 one without it says `sign_off_grant: false`, and only one without it may say so.

v0.1 adds these, which `validate.mjs` also checks:

7. A record that uses a v0.1 addition (`people`, a sign-off's `sign_off_grant` or `unlisted_evidence`, a rejection without `note`) says `agent-work-record/v0.1`. A v0 record is checked by every v0 rule, unchanged.
8. A person in `people` is not an agent, appears there once, is not already named as an agent's `on_behalf_of`, a grant's `granted_by` or a sign-off's `by`, is the `actor` of at least one event, and of only `work.status_changed` and `claim.made` events.
9. Each `unlisted_evidence` item appears once on its sign-off, is cited in that sign-off's `evidence`, and its `id` is no other object in the record. A sign-off's `evidence` names record evidence or its own `unlisted_evidence`. `sign_off_grant` needs `via`.

### What v0 does not check

These are left to the writer in v0. A record can break them and still pass:

- Time order between objects: a sign-off may be dated before the evidence it cites, and evidence `at` need not match its `evidence.added` event.
- A grant used before its `grant.issued` event: liveness reads the grant's `issued_at`, not the event's time.
- Repeats: a second `agent.connected` for the same agent, or a second `grant.issued` for the same grant.
- Actions other than `sign_off` (see [Grants](#2-grants)), and the free-text `excludes`.
- Freshness: whether a sign-off's `subject` matches the `subject` of the evidence it cites.
- v0.1: whether a record that says `agent-work-record/v0.1` uses any v0.1 addition. Writers should say v0.1 only when it does.
- v0.1: whether two sign-offs that keep a snapshot with the same `id` in `unlisted_evidence` agree on its content. Each sign-off's snapshot is what that person saw.

## End-to-end example

Dana connects two agents, Builder and Reviewer. She lets Builder work on issue 42 and open a pull request, but not merge, for 24 hours. Builder opens the pull request, adds the passing CI run and a screenshot, and says the work is ready for review. Reviewer adds an independent review. Builder writes a summary and says the work is done. Dana checks it on staging, accepts it based on four pieces of evidence, moves it to Accepted and ends Builder's grant.

This block must equal [examples/end-to-end.json](examples/end-to-end.json); the check compares them.

<!-- validate: record same-as=examples/end-to-end.json -->
```json
{
  "spec": "agent-work-record/v0",
  "id": "urn:uuid:6f1d2c4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f",
  "workspace": "https://tracker.example.com/w/acme",
  "work": {
    "id": "https://tracker.example.com/w/acme/issues/42",
    "title": "Add CSV export to the reports page"
  },
  "agents": [
    {
      "id": "https://tracker.example.com/w/acme/agents/builder",
      "name": "Builder",
      "on_behalf_of": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
      "client": "claude-code",
      "model": "claude-opus-5-5"
    },
    {
      "id": "https://tracker.example.com/w/acme/agents/reviewer",
      "name": "Reviewer",
      "on_behalf_of": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
      "client": "codex"
    }
  ],
  "grants": [
    {
      "id": "urn:uuid:0b6c9f1a-2d3e-4f50-8a61-7b8c9d0e1f20",
      "agent": "https://tracker.example.com/w/acme/agents/builder",
      "granted_by": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
      "actions": ["read", "write", "open_pull_request"],
      "excludes": ["production data changes", "new paid infrastructure"],
      "work": "https://tracker.example.com/w/acme/issues/42",
      "issued_at": "2026-10-14T09:01:00Z",
      "expires_at": "2026-10-15T09:01:00Z",
      "note": "Go ahead on #42 and open a PR. Do not merge."
    },
    {
      "id": "urn:uuid:1c7d0a2b-3e4f-4061-9b72-8c9d0e1f2031",
      "agent": "https://tracker.example.com/w/acme/agents/reviewer",
      "granted_by": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
      "actions": ["read", "write"],
      "work": "https://tracker.example.com/w/acme/issues/42",
      "issued_at": "2026-10-14T09:05:00Z",
      "expires_at": "2026-10-15T09:05:00Z"
    }
  ],
  "evidence": [
    {
      "id": "urn:uuid:2d8e1b3c-4f50-4172-8c83-9d0e1f203142",
      "kind": "pull_request",
      "uri": "https://github.com/acme/app/pull/318",
      "claim": "ready_for_review",
      "by": "https://tracker.example.com/w/acme/agents/builder",
      "at": "2026-10-14T11:00:00Z",
      "note": "Head 3f2a9c1."
    },
    {
      "id": "urn:uuid:3e9f2c4d-5061-4283-9d94-0e1f20314253",
      "kind": "ci_run",
      "uri": "https://github.com/acme/app/actions/runs/123456789",
      "claim": "ready_for_review",
      "by": "https://tracker.example.com/w/acme/agents/builder",
      "at": "2026-10-14T11:20:00Z",
      "subject": { "gitCommit": "3f2a9c1435b35d5f7909a03b9e61584db41b2143" },
      "result": "pass",
      "note": "All checks at head 3f2a9c1."
    },
    {
      "id": "urn:uuid:4fa03d5e-6172-4394-8ea5-1f2031425364",
      "kind": "screenshot",
      "uri": "https://tracker.example.com/w/acme/issues/42/attachments/9b1e7c22",
      "claim": "done",
      "by": "https://tracker.example.com/w/acme/agents/builder",
      "at": "2026-10-14T11:25:00Z",
      "digest": { "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" },
      "note": "Export button on the reports page, light theme."
    },
    {
      "id": "urn:uuid:5ab14e6f-7283-44a5-9fb6-203142536475",
      "kind": "review",
      "uri": "https://github.com/acme/app/pull/318#pullrequestreview-2201",
      "claim": "done",
      "by": "https://tracker.example.com/w/acme/agents/reviewer",
      "at": "2026-10-14T12:00:00Z",
      "subject": { "gitCommit": "3f2a9c1435b35d5f7909a03b9e61584db41b2143" },
      "result": "pass",
      "note": "Independent review of head 3f2a9c1. No blocking findings."
    },
    {
      "id": "urn:uuid:6bc25f70-8394-45b6-80c7-314253647586",
      "kind": "summary",
      "uri": "https://tracker.example.com/w/acme/issues/42#brief",
      "claim": "done",
      "by": "https://tracker.example.com/w/acme/agents/builder",
      "at": "2026-10-14T12:10:00Z",
      "note": "What changed: an Export CSV button on Reports. How to check: open Reports, export, open the file. Not done: Excel format."
    }
  ],
  "signoffs": [
    {
      "id": "urn:uuid:7cd36081-94a5-46c7-91d8-425364758697",
      "by": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
      "decision": "accept",
      "claim": "done",
      "subject": { "gitCommit": "3f2a9c1435b35d5f7909a03b9e61584db41b2143" },
      "evidence": [
        "urn:uuid:3e9f2c4d-5061-4283-9d94-0e1f20314253",
        "urn:uuid:4fa03d5e-6172-4394-8ea5-1f2031425364",
        "urn:uuid:5ab14e6f-7283-44a5-9fb6-203142536475",
        "urn:uuid:6bc25f70-8394-45b6-80c7-314253647586"
      ],
      "at": "2026-10-14T15:00:00Z",
      "note": "Exported a real report on staging. Looks right."
    }
  ],
  "events": [
    { "seq": 1, "at": "2026-10-14T09:00:00Z", "actor": "https://tracker.example.com/w/acme/people/dana", "type": "agent.connected", "ref": "https://tracker.example.com/w/acme/agents/builder" },
    { "seq": 2, "at": "2026-10-14T09:01:00Z", "actor": "https://tracker.example.com/w/acme/people/dana", "type": "grant.issued", "ref": "urn:uuid:0b6c9f1a-2d3e-4f50-8a61-7b8c9d0e1f20" },
    { "seq": 3, "at": "2026-10-14T09:04:00Z", "actor": "https://tracker.example.com/w/acme/people/dana", "type": "agent.connected", "ref": "https://tracker.example.com/w/acme/agents/reviewer" },
    { "seq": 4, "at": "2026-10-14T09:05:00Z", "actor": "https://tracker.example.com/w/acme/people/dana", "type": "grant.issued", "ref": "urn:uuid:1c7d0a2b-3e4f-4061-9b72-8c9d0e1f2031" },
    { "seq": 5, "at": "2026-10-14T09:10:00Z", "actor": "https://tracker.example.com/w/acme/agents/builder", "type": "work.status_changed", "ref": "https://tracker.example.com/w/acme/issues/42", "note": "Ready to In Progress" },
    { "seq": 6, "at": "2026-10-14T11:00:00Z", "actor": "https://tracker.example.com/w/acme/agents/builder", "type": "evidence.added", "ref": "urn:uuid:2d8e1b3c-4f50-4172-8c83-9d0e1f203142" },
    { "seq": 7, "at": "2026-10-14T11:20:00Z", "actor": "https://tracker.example.com/w/acme/agents/builder", "type": "evidence.added", "ref": "urn:uuid:3e9f2c4d-5061-4283-9d94-0e1f20314253" },
    { "seq": 8, "at": "2026-10-14T11:25:00Z", "actor": "https://tracker.example.com/w/acme/agents/builder", "type": "evidence.added", "ref": "urn:uuid:4fa03d5e-6172-4394-8ea5-1f2031425364" },
    { "seq": 9, "at": "2026-10-14T11:30:00Z", "actor": "https://tracker.example.com/w/acme/agents/builder", "type": "claim.made", "ref": "https://tracker.example.com/w/acme/issues/42", "claim": "ready_for_review" },
    { "seq": 10, "at": "2026-10-14T12:00:00Z", "actor": "https://tracker.example.com/w/acme/agents/reviewer", "type": "evidence.added", "ref": "urn:uuid:5ab14e6f-7283-44a5-9fb6-203142536475" },
    { "seq": 11, "at": "2026-10-14T12:10:00Z", "actor": "https://tracker.example.com/w/acme/agents/builder", "type": "evidence.added", "ref": "urn:uuid:6bc25f70-8394-45b6-80c7-314253647586" },
    { "seq": 12, "at": "2026-10-14T12:15:00Z", "actor": "https://tracker.example.com/w/acme/agents/builder", "type": "claim.made", "ref": "https://tracker.example.com/w/acme/issues/42", "claim": "done" },
    { "seq": 13, "at": "2026-10-14T15:00:00Z", "actor": "https://tracker.example.com/w/acme/people/dana", "type": "signoff.recorded", "ref": "urn:uuid:7cd36081-94a5-46c7-91d8-425364758697" },
    { "seq": 14, "at": "2026-10-14T15:00:00Z", "actor": "https://tracker.example.com/w/acme/people/dana", "type": "work.status_changed", "ref": "https://tracker.example.com/w/acme/issues/42", "note": "Human Review to Accepted" },
    { "seq": 15, "at": "2026-10-14T15:05:00Z", "actor": "https://tracker.example.com/w/acme/people/dana", "type": "grant.revoked", "ref": "urn:uuid:0b6c9f1a-2d3e-4f50-8a61-7b8c9d0e1f20", "note": "Work accepted." }
  ]
}
```

## Validation

One command, from the repository root, with Node 24 and nothing installed:

```sh
node docs/spec/validate.mjs
```

It exits 0 only when all of these hold:

- The schema uses only the keyword subset the script enforces: `$ref` (local `$defs` only), `type`, `const`, `enum`, `pattern`, `format` (`uri` and `date-time` only), `required`, `properties`, `additionalProperties: false`, `items`, `minItems`, `minLength`, `minimum`, `anyOf`, `if` and `then`. Any other keyword fails the run, and so does an assertion keyword beside `$ref` (the script follows `$ref` and would skip it), so the schema cannot quietly depend on a rule the script skips. Dates must be real calendar dates; leap seconds (`:60`) are refused as a simplification.
- Every file in `examples/`, `examples/v0.1/` and `examples/hydrant/` passes the schema and the [record rules](#record-rules), and every file in `examples/fragments/` passes the fragment schema.
- Every file in `examples/invalid/` fails with its expected message. Each breaks one rule: a timestamp without `T` and zone, an impossible date (February 30), a v0 rejection without a reason, an unknown field, an agent acting after its grant expired, an agent signing off without a `sign_off` grant and without saying `sign_off_grant: false`, an agent recording a person's sign-off without naming itself in `via`, a `grant.revoked` event that names evidence, and two audit events swapped. The two agent cases say `agent-work-record/v0.1`, to show v0.1 still refuses them. A rejection without a reason is still invalid in v0 (`examples/invalid/reject-without-note.json` says v0); the same record saying v0.1 is valid (`examples/v0.1/reject-without-note.json`). The two invalid fragments are an event that carries its own `seq` and `at`, and an evidence item whose `claim` is a number.
- Every JSON block in this document marked for validation passes against its schema part, and the end-to-end block equals the example file.

Given paths (`node docs/spec/validate.mjs record.json ...`), it checks only those records, against the schema and the record rules, and exits 1 if any fails.

`scripts/check_backlog.py` runs this command, so CI checks it wherever it checks the docs: the docs tier, the quality suite and release validation. A pull request that changes only `docs/spec/` stays in the cheap docs tier.

The schema is plain draft 2020-12, so any conforming validator can check shape too. Its top level accepts a record or either kind of fragment. Only the record rules need the script (or an equivalent written from the list above).

## v0.1 additions

v0.1 (native #710) is additive. Every v0 record still validates and means the same, and every v0 rule still applies to a record that says `agent-work-record/v0`. A writer says `agent-work-record/v0.1` only for a record that uses one of these additions, so a v0 reader keeps reading every other record. Fragments are unchanged and stay `agent-work-record/v0`. Signing keeps `predicateType` `https://agentworkrecord.org/v0` for both; the record's own `spec` says which one it is.

v0 can name a person only as an agent's person, a grantor or a decider, and needs an agent's sign-off to carry a `sign_off` grant. So a v0 writer had to leave out what follows. v0.1 keeps each one, said plainly.

### People who only acted

`people` lists, with `role` `actor`, the people who moved the work or made a claim and are named nowhere else. They may be the `actor` of `work.status_changed` and `claim.made` events, and nothing else. A person already named as an agent's person, a grantor or a decider is not listed again. `actor` is the only role v0.1 defines.

<!-- validate: listed_person -->
```json
{ "id": "https://tracker.example.com/w/acme/people/sam", "name": "Sam Ortiz", "role": "actor" }
```

### Sign-offs recorded without a grant

A sign-off an agent recorded for a person without a live `sign_off` grant from them stays, with `sign_off_grant: false`. A reader shows it as recorded without that permission. Saying `false` while the agent held a live grant is an error, and the agent's event still needs some live grant (rule 5).

### Rejections without a reason

A `reject` sign-off may leave out `note` when the reason was not recorded. v0 still requires it.

### Cited evidence no longer listed

When evidence a person cited is no longer listed (its source replaced it, such as a pull request that moved to a new head), the sign-off keeps it in `unlisted_evidence` as it stood when they decided, and cites it in `evidence` by the same `id`. A snapshot has `id`, `kind`, `uri` and `at` and may have `subject`, `result` and `note`. It has no creating event: the sign-off is its record.

<!-- validate: signoff -->
```json
{
  "id": "urn:uuid:8de47192-a5b6-47d8-a2e9-536475869708",
  "by": { "id": "https://tracker.example.com/w/acme/people/dana", "name": "Dana Reyes" },
  "via": "https://tracker.example.com/w/acme/agents/builder",
  "decision": "accept",
  "claim": "done",
  "evidence": ["urn:uuid:8ef58293-a6b7-48c9-b3fa-647586970819"],
  "at": "2026-10-14T15:00:00Z",
  "sign_off_grant": false,
  "unlisted_evidence": [
    {
      "id": "urn:uuid:8ef58293-a6b7-48c9-b3fa-647586970819",
      "kind": "ci_run",
      "uri": "https://github.com/acme/app/actions/runs/123456700",
      "at": "2026-10-14T10:40:00Z",
      "subject": { "gitCommit": "1b0c8e2f9a7d6c5b4a3928170f6e5d4c3b2a1908" },
      "result": "pass"
    }
  ]
}
```

Each addition has a whole record in `examples/v0.1/`: `person-actor.json`, `signoff-without-grant.json`, `reject-without-note.json` and `unlisted-evidence.json`.

## Signing (optional)

v0 records are valid unsigned. To sign, wrap the record or a single piece of evidence as the predicate of an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) inside a [DSSE envelope](https://github.com/secure-systems-lab/dsse):

- `_type`: `https://in-toto.io/Statement/v1`
- `subject`: what the record is about, by digest, such as the merged commit (`{ "name": "acme/app", "digest": { "gitCommit": "..." } }`)
- `predicateType`: `https://agentworkrecord.org/v0`
- `predicate`: the record
- Envelope `payloadType`: `application/vnd.in-toto+json`, as the [in-toto envelope spec](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md) requires

A v0.1 record is signed under the same `predicateType`, so a verifier must read the payload record's `spec` before trusting it: a v0-only verifier refuses a payload that says `agent-work-record/v0.1`. The schema `$id` also stays `https://agentworkrecord.org/schema/v0.json` for both versions.

Store the envelope where it can be fetched and point to it with an `attestation` evidence item and its `digest`. Key distribution, trust roots and transparency logs are out of scope for v0.

To verify, decode `payload` from base64 and check each signature over the DSSE pre-authentication encoding, `DSSEv1 <len(payloadType)> <payloadType> <len(payload)> <payload>` (lengths in bytes, ASCII decimal, single spaces), with the key its `keyid` names. Then read the Statement: `predicateType` must be the one above and `predicate` is the record. A Hydrant export names as subject the merged commit of each pull request linked as closing the issue (not one that only mentions it), or, with none, the record id with the sha256 of the record as compact JSON exactly as JavaScript's `JSON.stringify` writes it (no spaces, no escaping beyond JSON's own). It signs with Ed25519, publishes its public keys at `/.well-known/agent-work-record/keys.json` and uses the hex sha256 of the raw public key as `keyid`; its help docs have a worked Node example.

## Prior art

Checked on October 14, 2026.

### in-toto attestations and SLSA

- **What they are.** An [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) binds a typed predicate (`predicateType` URI, `predicate` object) to software artifacts named by digest (`subject[].digest`). It is usually signed in a [DSSE](https://github.com/secure-systems-lab/dsse) envelope with `payloadType` `application/vnd.in-toto+json` ([envelope spec](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md)). [SLSA provenance](https://slsa.dev/spec/v1.0/provenance) is the best-known predicate (`predicateType` `https://slsa.dev/provenance/v1`, with `buildDefinition` and `runDetails`); SLSA 1.2 is the current version.
- **What v0 reuses.** The signing path (Statement plus DSSE, unchanged), the `{ "sha256": hex }` digest shape, and URIs for type identifiers. A v0 record can be an in-toto predicate.
- **Overlap.** Both say "this artifact came from this process". A SLSA provenance document can be a v0 `attestation` evidence item.
- **Why v0 does not duplicate it.** in-toto describes artifacts by digest and the steps that built them. It has no notion of a person granting an agent scoped, expiring permission, of a claim like "done", or of a person accepting or rejecting it. v0 is a predicate-shaped record about work and people, not another attestation framework.

### Model Context Protocol (MCP)

- **What it is.** [MCP](https://modelcontextprotocol.io/specification/latest) (current revision 2026-07-28) connects agent hosts to servers that offer tools, resources and prompts. HTTP servers [authorize](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) with OAuth 2.1, Protected Resource Metadata (RFC 9728), resource indicators (RFC 8707) and scopes. The spec asks hosts to get user consent before tool calls but says MCP "cannot enforce these security principles at the protocol level".
- **What v0 reuses.** An agent's MCP connection is a natural agent `id`, its OAuth client (or Client ID Metadata Document URL) a natural `client`, and its granted scopes map to `read` and `write` actions. MCP is a good transport for writing records (a tracker can expose a tool that appends evidence).
- **Overlap.** Both care about consent. An OAuth grant is a v0 grant at workspace scope.
- **Why v0 does not duplicate it.** MCP authorizes a connection to a server. It does not record which unit of work a permission covered, what the person reserved, what evidence an agent offered, or who signed off. Tokens are credentials; a v0 grant is the human-readable record of the permission and is safe to share.

### Google Agent2Agent (A2A)

- **What it is.** [A2A](https://a2a-protocol.org/latest/specification/) (version 1.0.0) lets agents call other agents. An agent publishes an Agent Card (at `/.well-known/agent-card.json`) with its identity, skills and security schemes. Work is a Task with states such as `TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`, `TASK_STATE_COMPLETED` and `TASK_STATE_REJECTED`, and outputs are Artifacts.
- **What v0 reuses.** An Agent Card URL is a good agent `id`. A2A Artifacts can be evidence by `uri`.
- **Overlap.** `TASK_STATE_COMPLETED` is an agent's own "done". `AUTH_REQUIRED` and `INPUT_REQUIRED` are the moment a person might grant or decide.
- **Why v0 does not duplicate it.** A2A is agent-to-agent messaging. Its spec says it "does not define the scope, representation, validity, or revocation semantics" of in-task authorization, and it has no record of a person's sign-off or an audit trail. v0 records those, and works whether or not the agents spoke A2A.

### OpenTelemetry GenAI semantic conventions

- **What they are.** Span and attribute names for AI calls, now maintained in [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai). [Agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) use operations such as `create_agent`, `invoke_agent` and `execute_tool`, with `gen_ai.agent.id`, `gen_ai.agent.name` and `gen_ai.agent.version`. Status is still Development.
- **What v0 reuses.** The same agent identity: a v0 agent `id` should equal `gen_ai.agent.id` where both exist, so traces and records join. A trace link can be `other` evidence.
- **Overlap.** Both record what an agent did and when.
- **Why v0 does not duplicate it.** Telemetry is operational: sampled, short-lived and fine-grained (every model and tool call). v0 keeps the few durable facts a person needs to trust the work: permission, evidence, decision. It never records prompts or model output.

## Hydrant mapping

Where Hydrant records each v0 field today, checked against `origin/main` at 66c62348. "Gap" means Hydrant has nothing structured for it. "Partial" means something close with a stated difference. Migrations are in `migrations/`; the agent API is MCP in `worker/mcp.ts`.

### Record and work

| v0 field | Hydrant today |
|---|---|
| `spec` | Gap. The closest is the workspace export's `exportFormatVersion` (`worker/workspace-export.ts:28`), which versions a whole-workspace dump. |
| `id` | Gap. No per-issue record exists. |
| `workspace` | `workspace.id` (`002_workspaces.sql:6`); agents carry it as `auth_actor.workspace_id` (`011_agent_credentials.sql:17`). |
| `work.id` | `issue.id` (`003_issues.sql:45`); MCP `get_issue` returns its `url` (`worker/mcp.ts:313`). |
| `work.title` | `issue.title` (`003_issues.sql:48`). |

### Agent identity

| v0 field | Hydrant today |
|---|---|
| `agents[].id` | `auth_actor.id` with `kind = 'agent'` (`011_agent_credentials.sql:14-15`), one per connection or key. Partial: a connection can also be linked to a named agent (`agent_actor_link.named_agent_id`, `058_agent_actor_link.sql:4-12`, pointing at `issue_assignee`, `003_issues.sql:11`); v0 has one identity, not two. |
| `agents[].name` | `auth_actor.name` (`011_agent_credentials.sql:18`). Reads and export render it as "Name (agent; via Person)" (`worker/issues.ts:1145`, `worker/workspace-export.ts:181`, `cli/src/view.ts:43-46`). |
| `agents[].on_behalf_of` | `auth_actor.user_id`, the granting user (`011_agent_credentials.sql:16`), read as `granting_user_id`/`granting_user_name` (`worker/issues.ts:1145`). |
| `agents[].client` | `auth_actor.client_id` for OAuth connections (`034_mcp_oauth.sql:36`) and `oauth_client.name` (`034_mcp_oauth.sql:5`). Gap for API keys, which have no client. |
| `agents[].model` | Gap. |

### Grants

| v0 field | Hydrant today |
|---|---|
| `grants[].id` | Partial. The connection (`auth_actor.id`) is the only permission object; Playbook grants are one row per actor (`playbook_grant`, `021_playbook.sql:24`). Ship grants have no id: they are prose in `docs/decisions.md` (for example `:544-546`) and comments on native issues. |
| `grants[].agent` | `auth_actor.id`; `playbook_grant.actor_id` (`021_playbook.sql:25`). |
| `grants[].granted_by` | `auth_actor.user_id`. Ship grants name Henry or Arus in prose only (`docs/decisions.md:546`). |
| `grants[].actions` | Partial. `read`/`write`: `auth_actor.write_access` (`034_mcp_oauth.sql:37`, `079_agent_key_access.sql`) and OAuth scopes `workspace.read`/`workspace.write` (`worker/oauth-config.ts:11`, `oauth_access_token.scopes` in `034_mcp_oauth.sql:9`). Playbook `propose`/`publish`/`review` (`021_playbook.sql:26`). Gap for `open_pull_request`, `merge`, `release` and `sign_off`: these exist only as ship-grant prose (`.agents/skills/ship/SKILL.md`). |
| `grants[].excludes` | Gap. Ship grants list "Reserved" items in prose (`docs/decisions.md:546`). |
| `grants[].work` | Gap. Connections and keys are workspace-wide; per-issue scope exists only in ship-grant prose. |
| `grants[].issued_at` | `auth_actor.created_at` (`011_agent_credentials.sql:21`). |
| `grants[].expires_at` | Partial. Credential expiry, not grant expiry: `auth_api_key.expiresAt` (`011_agent_credentials.sql:3`), `oauth_access_token.expiresAt` (`034_mcp_oauth.sql:9`). |
| `grants[].note` | Gap. Ship-grant records quote the exact words, as issue comments. |

### Evidence

| v0 field | Hydrant today |
|---|---|
| `evidence[].id` | Partial. Each source has its own key: pull request `(workspace_id, id)` (`063_github_pull_requests.sql:61-62`), `attachment.id` (`005_attachments.sql:3`). No shared evidence id. |
| `evidence[].kind` | `pull_request`: `github_pull_request` plus `github_issue_link` (`063_github_pull_requests.sql:61`, `:96`). `ci_run`: `github_pull_request.readiness` (`075_github_readiness.sql:12`), checks typed as `ReadinessCheck` (`shared/github-readiness.ts:9`). `review`: `github_pull_request_review` (`063_github_pull_requests.sql:85`). `screenshot`: `attachment` (`005_attachments.sql:2`). `summary`: the reviewer brief `issue.brief` (`100_issue_brief.sql:7`; MCP `update_issue` `brief`, `worker/mcp.ts:98`). `test_output`, `attestation`: gap (test output lives only in comment text, `issue_activity.comment_body`, `004_comments.sql:32`). |
| `evidence[].uri` | `github_pull_request.url` (`063_github_pull_requests.sql:67`); `ReadinessCheck.url` (`shared/github-readiness.ts:9`); attachment URLs (`worker/workspace-export.ts:192`). Gap for the brief, which has no URL of its own. |
| `evidence[].claim` | Gap. The claim is implied by the stage the issue is in (`issue_activity.before_status_name`/`after_status_name`, `006_workflow.sql:63-64`). |
| `evidence[].by` | `github_issue_link.actor_id` (`063_github_pull_requests.sql:103`), `attachment.uploader_id` (an `auth_actor` since `011_agent_credentials.sql:50`), `issue.brief_actor` (`100_issue_brief.sql:8`). |
| `evidence[].at` | `github_issue_link.created_at` (`063_github_pull_requests.sql:104`), `attachment.created_at` (`005_attachments.sql:13`), readiness `observed_at` (`shared/github-readiness.ts:16`), `issue.brief_at` (`100_issue_brief.sql:9`). |
| `evidence[].subject` | Partial. Pull requests and CI: `github_pull_request.head_sha` (`075_github_readiness.sql:10`) and the readiness observation's `head_sha` (`shared/github-readiness.ts:16`), which pins checks to one head. Gap for screenshots and briefs. |
| `evidence[].result` | Partial. `ReadinessCheck.state` has six values (`success`, `pending`, `failing`, `neutral`, `skipped`, `unknown`; `shared/github-readiness.ts:8`); review `state` has four (`063_github_pull_requests.sql:89`). Both map onto v0's four. |
| `evidence[].digest` | `attachment.sha256` (`005_attachments.sql:11`). Pull request heads map to `subject`, not `digest`. |
| `evidence[].note` | The brief text; comment bodies. |

### Sign-off

| v0 field | Hydrant today |
|---|---|
| `signoffs[].id` | `issue_activity.id` of the row that carries the decision (`003_issues.sql:65`). |
| `signoffs[].by` | `issue_activity.actor_id` resolved to its granting user (`auth_actor.user_id`): "an agent decides as its granting user" (`worker/mcp.ts:102-103`). Environment approvals also keep `issue.approval_user` (`066_environment_approvals.sql:7`). |
| `signoffs[].via` | `issue_activity.actor_id` when that actor is an agent. Since #711 an agent decides only with a live `sign_off` grant from its granting user (#693); decisions recorded before without one carry `sign_off_grant: false` (#697) and export with it in v0.1. |
| `signoffs[].decision` | Review stages: `review_event.decision` `accept`/`send_back` (`shared/review.ts:7-10`, `094_stage_reviewers.sql:9`). Environments: `approval_event.decision` `approved`/`behind_flag`/`held`/`passed`/`waiting`/`rejected` (`shared/environments.ts:219`, `066_environment_approvals.sql:8`). Map: `accept` = accept/approved, `reject` = send_back/rejected, `abstain` = passed. |
| `signoffs[].claim` | Partial. `review_event.status` (the stage left, `shared/review.ts:10`) or `approval_event.environment_id`; the claim is the stage, not a named claim. |
| `signoffs[].subject` | Gap. `review_event` holds only the decision and stage (`shared/review.ts:10`) and `approval_event` the decision and environment (`shared/environments.ts:219`); neither records the head that was accepted. |
| `signoffs[].evidence` | Gap. Decisions do not cite what they relied on. Project acceptance has free-text `evidence` (`project_acceptance`, `022_projects.sql:42-45`) at project level only. |
| `signoffs[].at` | `issue_activity.created_at` (`003_issues.sql:72`). |
| `signoffs[].note` | The comment that send back, hold and reject must post (`worker/mcp.ts:102-103`), stored as an ordinary comment. |

### Audit events

| v0 field | Hydrant today |
|---|---|
| `events[].seq` | `issue_activity.position` (`004_comments.sql:5`); `project_activity.position` (`022_projects.sql:36`); `playbook_event.version` (`021_playbook.sql:41`). |
| `events[].at` | `issue_activity.created_at` (`003_issues.sql:72`). |
| `events[].actor` | `issue_activity.actor_id`, an `auth_actor` (`011_agent_credentials.sql:47`). |
| `events[].type` | Partial. `issue_activity.kind` plus its event columns (`review_event`, `approval_event`, `pull_request_event`, `comment_event`); the feed's `FeedRawEvent.kind` (`shared/activity-feed.ts:53`, `:65`). `agent.connected`, `grant.issued`, `grant.revoked`, `agent.revoked`: no issue history row; only `auth_actor.created_at`, `revoked_at` and `revoked_reason` (`011_agent_credentials.sql:21-22`, `112_connection_expiry.sql:8-9`). `claim.made`: gap. |
| `events[].ref` | `issue_activity.issue_id`. |
| `events[].claim` | Gap. |
| `events[].note` | `before_status_name`/`after_status_name` (`006_workflow.sql:63-64`), `comment_body`. |

Append-only today: `auth_actor` identity and revocation are permanent (trigger in `011_agent_credentials.sql:45`, extended in `112_connection_expiry.sql:10-19`), and Playbook events and task-context records are immutable (`021_playbook.sql:47`, `:61`). `issue_activity` is not strictly append-only: comment rows can be edited and resolved (`083_comment_edits.sql:4`, `016_comment_threads.sql:5`).

Export today: `issue_activity`, `github_pull_request`, `attachment` and `agent_actor_link` are exported, but `auth_actor`, `issue_receipt` and `playbook_context` are withheld (`worker/workspace-export.ts:17-18`). Agents appear in `people.jsonl` by display name only (`worker/workspace-export.ts:181`). An export cannot rebuild who granted what.

### Hydrant data deliberately left out of v0

- **Planning fields:** priority, size, labels, rank, cycles, projects, milestones, dependencies, snooze. They describe how work is organized, not who allowed or accepted it.
- **Release mechanics:** environments, promotions, clearance, flag keys, `held` and `behind_flag` decisions, dockets. They are about shipping batches; v0 stops at the `released` claim.
- **Conversation:** comments, threads, reactions, follows, notifications. Only a decision's reason is kept, as `note`.
- **"Looks right" acknowledgements** (`acknowledge_issue`, `worker/mcp.ts:346`). Hydrant itself says they are not a verdict.
- **Task-context receipts** (`playbook_context`, `record_task_context`). They prove guidance was delivered, and `docs/playbook.md:11` says delivery does not prove understanding or compliance.
- **Request receipts** (`issue_receipt`, `003_issues.sql:76`). Retry plumbing, not history.
- **Credentials:** key hashes, tokens, auth.md registration codes. A record must be safe to share.
- **GitHub automation outcomes and readiness internals** (probe revisions, mergeability). Evidence keeps the result and link only.
- **Identity decoration:** avatars, icons, lanes, assignee descriptions. Plans, billing and analytics.

### Reference implementation notes (#699)

Hydrant assembles a record at read time from what it stores, and part of its evidence list is derived live from its sources (a pull request's current head, the current brief). So `seq` is the position at merge time: a fragment receipt's `seq` and `at` are as of the merge, and a later export may renumber. The export says v0.1 only when it keeps one of the [v0.1 additions](#v01-additions) (#710): a person who only moved the work or made a claim, an agent sign-off recorded without a grant, a rejection without its reason, or cited evidence no longer listed.

## Gaps, filed as Reference implementation issues

Filed on native Hydrant, all blocked by #681.

1. **#693 Record agent grants as data, scoped to an issue and expiring on their own.** Ship grants are prose today; connections are workspace-wide and expiry is credential expiry.
2. **#694 Record each agent's client and model.** Fills `client` and `model`.
3. **#695 Typed evidence list on issues with stable ids.** Pull requests, CI runs, screenshots, briefs and test output with kind, claim, result, digest and `subject`.
4. **#696 "Ready for review" and "done" as claim events,** not only stage moves.
5. **#697 Decisions cite evidence and the accepted commit, with sign-off as its own agent permission.** Blocked by #693 and #695.
6. **#698 Grant and connection start and end events in issue history.** Blocked by #693.
7. **#699 Export one record per issue (MCP tool and CLI) and accept fragments.** Checked by `validate.mjs`. Blocked by #693, #695 and #697.
8. **#700 Optional signed records** in an in-toto Statement and DSSE envelope. Blocked by #699.

Publishing is #701 (page on hydrant.dev and the public repo); the first tool outside Hydrant is #702 (an open-source GitHub Action that emits evidence fragments from CI), blocked by #701.

## Decisions

Every question raised while drafting is decided. Henry approved the format and signing defaults and the name and URI, and delegated the rest.

- **Name.** Agent Work Record (AWR). Reason: it says what it is and is not branded as any one vendor's.
- **Format.** JSON with a JSON Schema (draft 2020-12). Reason: every language reads it, validators exist everywhere, and in-toto predicates are JSON.
- **Signing.** Optional, using in-toto Statement v1 in DSSE. Reason: signing needs key management, which would break the afternoon-to-implement goal. Reusing in-toto means no new signature format when signing is wanted.
- **Location and license.** Drafted in `docs/spec/` in this private repository. At Publish: Apache-2.0 for the text, schema and validator (its patent grant is what adopters' lawyers look for); the spec repository under the Background-Craft GitHub organization; a page on hydrant.dev; `agentworkrecord.org` redirects to that page and stays the stable identifier. Hosting with the vendor works when the spec needs nothing from the vendor to run, as WorkOS showed with auth.md.

1. **Spec URI.** `https://agentworkrecord.org/v0` is the in-toto `predicateType` and `https://agentworkrecord.org/schema/v0.json` the schema `$id`. Identifiers only: nothing needs to be served there for a record to be valid. A neutral domain keeps the identifier stable whoever hosts the pages; registering it is a Publish task.
2. **Hash chain.** Not in v0. Chaining events by hash needs RFC 8785 canonical JSON, and optional signing already covers tampering. Revisit in v0.1 if operators ask for it.
3. **Record or stream.** The record stays the main document. A system that does not own the work sends a [fragment](#fragments) (one evidence item or one event), and the tracker merges it.
4. **`excludes`.** Human-only text. Machine-checkable exclusions would turn into a policy language.
5. **Evidence freshness.** Evidence and sign-off take an optional `subject` digest set. A sign-off with `subject` accepted that exact content, and a later push makes it stale.
6. **Decisions.** Keep `accept`, `reject` and `abstain`. Hydrant's `held` and `behind_flag` are release mechanics, and URI-valued decisions would invite fragmentation.
7. **CI.** Done: `scripts/check_backlog.py` runs `node docs/spec/validate.mjs`, so every CI tier that checks the docs checks the spec, without adding a workflow step.

## Size check

- **Record: 55 fields** across 9 object shapes: record 9, work 2, person 2, agent 5, grant 9, evidence 10, sign-off 9, event 7, digest set 2. 37 are always required. Three rules add one each in a case: `note` on a rejection, `claim` on `claim.made`, and at least one of `sha256` or `gitCommit` in a digest set.
- **Fragment: 5 more fields** (`spec`, `workspace`, `work`, and one of `evidence` or `event`), reusing the evidence and event shapes (an event without `seq` or `at`, limited to two types). The schema file lists 68 property entries because the two fragment shapes and the fragment event repeat these.
- **4 closed vocabularies:** 6 actions, 8 evidence kinds, 3 decisions, 8 event types; plus 3 claims and 4 results. Actions and claims accept URIs for anything else.
- **6 record rules** and 7 merge rules, plus 3 for v0.1. The record rules are checked by a dependency-free script of 263 lines. v0.1 adds 3 optional fields (`people`, and `sign_off_grant` and `unlisted_evidence` on a sign-off) and 2 shapes (listed person, evidence snapshot). The [unchecked cases](#what-v0-does-not-check) are listed.
- **No infrastructure:** no server, registry, database or key service. A record is one JSON file, and a fragment is a smaller one.
