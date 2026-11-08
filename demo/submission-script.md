# Control Tower — two-minute submission video

Aim for 1:55 plus a five-second closing card. Record the actual application with legible text and clear audio. The times below are edit slots, not promised model response times. Capture the entire run; label compressed waits. Rehearse before recording.

| Time | On screen | Narration / action |
| --- | --- | --- |
| 0:00–0:12 | Healthy checkout, then **Simulate a bad deploy** | “During an outage, engineers have to investigate, coordinate and keep everyone informed at once. Control Tower coordinates the investigation while you stay in command. This demo uses simulated production.” |
| 0:12–0:27 | Automatic declaration and four investigators starting; retain the tower’s spoken alert | “It notices sustained checkout errors and starts Logs, Changes, Metrics and Comms without waiting for a prompt. A recent deploy is a suspect, not yet a proven cause.” |
| 0:27–0:47 | Logs finding, pool metrics, deploy diff | Ask: “Logs, what are you seeing?” Let the tower answer. “The investigators share evidence: connection timeouts, a saturated pool, and a change from fifty connections to five.” Use these words only if the run actually produced those findings. |
| 0:47–1:05 | Cited rollback recommendation or the investigator’s pending tool approval | “Risky actions stop for approval. If the investigators finish without a fix, a separate review reads their findings and visible deploys. It can recommend a rollback or ask for missing evidence.” Show numbered citations if the review produced them. |
| 1:05–1:21 | Approve the specific rollback, then falling errors | Say “approve” when the correct request is selected. Keep the confirmation. Label any cut: “Recovery wait shortened.” “The fix runs only after approval, and the tower watches the recovery.” |
| 1:21–1:37 | Resolve when healthy; generated postmortem, then one Activity trace | “The timeline records findings, actions and approvals. The postmortem is generated from those records. Activity lets us inspect the actual tool calls and spend.” Label a shortened generation wait. |
| 1:37–1:50 | Clearly captioned **Second run: external provider outage**; actual external 503 findings and an investigate decision | “In a second drill, the payment provider fails while our database stays healthy. A local rollback would not fix it. Here the review explains what to check next.” Include only an actual recorded result; do not replace it with a scripted UI. |
| 1:50–2:00 | Product name, public repository URL once confirmed, partner credits actually demonstrated | “Control Tower: proactive investigation, evidence you can inspect, and a human approving the change.” |

## If Jamie is ready

Replace up to ten seconds of the trace or second-run slot with a real retrieved meeting note and a resulting follow-up proposal. Say what changed because of that note. If the run used sample notes, caption them **Sample incident history** and do not imply a live Jamie request succeeded.

## Recording preparation

- Configure Anthropic and Reson8 keys locally. Configure Jamie only if the meeting and key are available. Keep keys and account details out of the capture.
- Run the bad-deploy scenario end to end once, including a specific approval and a completed postmortem. Capture it before editing.
- Restart the backend for a clean provider scenario. Let investigators finish, answer any customer-update approvals, and capture the actual evidence review. A wrong rollback recommendation needs fixing or disclosure, not editing away.
- Record at a readable resolution. Show the selected approval: a bare “approve” may otherwise address a different pending request.
- Export a video at or under two minutes. This file is a storyboard; it is not a recorded video or proof of a successful live rehearsal.

## Five-minute finalist presentation

| Time | Focus |
| --- | --- |
| 0:00–0:30 | The operator’s coordination problem and the simulated-production boundary |
| 0:30–2:20 | Detection, evidence gathering, voice supervision, and one approval |
| 2:20–3:15 | Recovery, timeline, postmortem, and one trace |
| 3:15–4:15 | The provider counterexample: why correlation does not justify rollback |
| 4:15–4:45 | Architecture and real Jamie integration if available; otherwise disclose samples |
| 4:45–5:00 | Value, current limitations, and repository |

Suggested “How it works” wording: **“Five samples from the same model; at least three must agree on the target and action. Otherwise it asks for clarification.”** Agreement is not a probability of correctness. The evidence review separately validates finding references and the deploy target; its reasoning is still a model judgment.
