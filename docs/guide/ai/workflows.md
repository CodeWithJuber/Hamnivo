# Build agent workflows

Workflows connect a conversation to a finite set of knowledge, decision, tool, approval, waiting,
delegation, and human-handoff steps. They keep a durable run history, so a wait or service restart
does not turn the workflow into an untracked background action.

People with **Automations: read** can view workflows, published versions, and runs. Creating,
saving, publishing, pausing, restoring, starting, or cancelling requires **Automations: manage**.

## Create a workflow

1. Open **Workflows** and choose a brand.
2. Choose **Create**, then start empty or choose a template for support, lead capture, billing help,
   service changes, after-hours handling, or human handoff.
3. Name the workflow and choose its coordinator agent. An automatic trigger must use the brand's
   current active default coordinator with a published version. A manual workflow may use another
   published agent from the same brand.
4. Choose when it starts: manually, when a chat starts, when a customer writes, when a chat closes,
   or when an offline message arrives.
5. Add and connect the steps. Choose the entry step, then set each step's next step or branches.
6. Open **Run limits** to set the maximum work for one run and explicitly allow any local
   specialist agents.
7. Save the draft. Open it again and choose **Publish** when it is ready.

A draft is editable; a published version is immutable. Saving uses the revision you opened, so a
second editor cannot silently overwrite a newer draft. **Restore version** copies an older
published version into the draft for review and publishing. It does not rewrite old runs.

Pausing a workflow stops new automatic and manual runs. A run already in progress stays pinned to
the published version with which it started.

## Available steps

| Step | Purpose |
|---|---|
| Trigger | The starting point for the selected event |
| Condition or branch | Chooses a path using the event, business hours, sign-in state, country, language, tag, or an earlier result |
| Knowledge lookup | Retrieves currently eligible passages from approved knowledge |
| Tool action | Sends a reviewed action through the normal tool permission and receipt checks |
| Approval | Waits for the approval required by the selected tool |
| Wait | Sleeps for 1 second to 24 hours, then resumes durably |
| Delegate | Asks one explicitly allowed local agent or one configured external A2A specialist for advice |
| Handoff | Ends the workflow and passes the conversation to a person with the recorded reason |

Definitions contain data only. They cannot run scripts, evaluate arbitrary expressions, or contain
loops. Publishing rejects missing or unreachable steps, cycles, duplicate step IDs, unsafe result
references, unapproved delegation targets, and run limits that cannot contain the graph.

When configuring a tool step, choose its reviewed tool from the **Action tool** list. For a
delegation step, choose the allowed local agent or external A2A connection from **Specialist**.
These labelled selectors show eligible choices for the current brand and workspace.

## Use an earlier step's result

The visual editor covers the common fields. **Advanced definition** also supports typed references
to an earlier completed step:

- `bindings` fills named tool arguments;
- `queryFrom` supplies a knowledge query;
- `requestFrom` supplies a delegation request; and
- a condition with `field: "result"` reads a referenced value.

The source step must occur on every possible path to the consuming step. References can traverse at
most six safe object keys or array indexes, and a tool step accepts at most 16 bindings. Prototype
keys, forward references, missing values, and oversized result data are rejected. Result values are
treated as untrusted input; they never carry permissions or bypass a tool's approval checks.

References retain the time and provenance of the original observation through later delegations.
Before using one, Hamnivo requires it to be no more than 60 seconds old and rechecks the knowledge,
agent, or connection that produced it. Asking a specialist to repeat stale input does not make the
input fresh. After a long **Wait**, add a new knowledge lookup or other live read before binding its
result into an action.

## Delegate to another agent

A local specialist must belong to the same brand, have a published version, and appear in the
workflow's delegate allowlist. It receives a private request and has no tools. If its advice cites
knowledge, Hamnivo keeps source, document, and version references and rechecks that the passages are
still current before the coordinator may use them.

For a private external specialist, first create an A2A connection under **Connectors**. The request
sends no transcript or customer identity, and the result is marked untrusted. External specialists
cannot create child delegations. See [Connect business systems and specialist agents](../integrations/connectors.md#connect-an-external-specialist-agent).

The coordinator sees workflow advice only for the same tenant, conversation, AI owner and ownership
epoch, tied to the current inbound message and no more than 60 seconds old. Tool outputs are not
used as conversational evidence. A takeover, cancellation, ownership change, expired deadline, or
stale knowledge stops or excludes the affected work. An active kill switch, archived specialist,
or disabled connection also blocks new work and prevents an in-flight result from being accepted at
its checkpoint.

For an automatic customer-message workflow, the first reply waits durably for queued or running
workflow evidence, checking once per second for at most 30 seconds. If the workflow reaches an
approval or **Wait** step, the reply proceeds immediately rather than waiting for that person or
timer. The normal inbound-message and reply deduplication rules still apply, so a retried event does
not publish a second reply. After 30 checks, the normal reply path continues with only context that
is still eligible. If the workflow hands off before the first reply, the AI publishes no reply and
leaves no delayed retry behind.

## Run limits and recovery

Each definition sets maximum steps, delegations, duration, and delegation depth. The enforced
limits are 100 steps, 8 delegations, 24 hours, and depth 3. Set smaller limits when a workflow does
not need the maximum.

The worker advances one durable step at a time. Tool actions resume through the existing
idempotent tool gateway after a worker interruption. An interrupted external delegation is marked
unknown and is not sent again automatically, because the specialist may already have acted on the
request. The run displays a reason when it fails or hands off.

## Review and control runs

Open a workflow to see recent runs. A run shows its state, conversation, wake time, reason, step
states, and available results. Knowledge passages and specialist output are labelled untrusted.
Use the Inbox link to inspect the conversation. You can cancel a queued, running, waiting, or
approval-waiting run.

For a manual test, publish and enable the workflow, enter an AI-owned conversation ID, and choose
**Start run**. Use a new disposable conversation and harmless tools. A workflow has no direct
"publish customer reply" step: the conversation coordinator remains responsible for any reply and
applies the normal evidence, ownership, and delivery checks.

Before enabling an automatic trigger, test both branches, approval waits, cancellation, human
takeover, and recovery from an unavailable connector. Repository-focused workflow tests do not
replace the final browser and full integration pipeline.
