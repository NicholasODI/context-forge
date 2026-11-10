# Memory retention and model-recall benchmark

Run from the repository root:

```sh
npm run benchmark:memory
```

The fixture performs **300 synthetic compactions in each of three profiles**:
8,192 / 32,768 / 131,072 declared context tokens. Observation/reflection budgets
are respectively 400/200, 1000/400, and 2000/800 estimated tokens. These are
deliberately small working sets, not recommended universal production settings.

It uses the real ledger fold, policy handling, ranked selection, safe drop
selection, deterministic structural compiler, continuity renderer, project
reminder, source recall, and Pi's public context/provider-message builders.
Worker proposals are synthetic; no background worker, local model, network,
extension registration, or user session/config/memory file is accessed.

The corpus plants pinned constraints, an obsolete value followed by an explicit
correction, a historical unpinned fact, a pinned decision, and changed task steps
and blockers. Fixture version 2 also plants an identical-content observation and
reflection sharing a hash, and checks their shapes and critical tag through every
compaction. Each profile adds 900 observations and 300 reflections, plus that
shared-hash seed reflection, with
periodic synthetic pruning proposals. All original source records stay in the
branch as in the extension's append-only ledger.

Measurements are separate:

| Measurement | What it establishes |
|---|---|
| Pin/correction exposure over cycles | The selected snapshot retained protected/current facts |
| Stale-value/action and prefix checks | Old corrections/task blocks did not accumulate |
| Observation/reflection budget checks | Ranked record output stayed within fixture budgets |
| Archive recovery | Recall by memory ID retrieved original source entries |
| Host summary projection | Only the latest compact-all summary was used |
| Exposed probes | A planted answer remained available in final summary/reminder |
| Optional answer scoring | A supplied model response returned the exact canary value |

Provider/model accuracy is **not measured by a passing retention test**. The
declared window is a fixture label and summary-size comparison; system prompts,
tool declarations, server templates, and full provider request overhead are not
modeled. It is not a throughput benchmark or a native omp compatibility test.

## Outputs and baseline

The explicit benchmark command writes generated, Git-ignored files:

- `benchmarks/results/latest.json`: metrics, answer key/exposure, and optional
  supplied-answer scores. With no answers, model recall is `not-run`.
- `benchmarks/results/probes.json`: one provider-style message pack per profile,
  containing only synthetic context and questions. No answer key is appended.

Ordinary `npm run check` runs the assertions without writing those artifacts.
The checked-in [baseline](baseline.json) records an offline run of the fixture.
Smaller budgets intentionally lose one unpinned historical fact from context
while retaining its archive source; the report exposes that distinction.

## Testing a local model without touching a production session

1. Run the offline benchmark to generate `probes.json`.
2. For each profile, submit **only its `messages` array** to a separate disposable
   model request. Preserve roles/order. Do not use the affected coding session,
   enable tools, or provide `latest.json` / `baseline.json` (they include answers).
3. Save parsed answers under each profile name:

   ```json
   {
     "tight-8k": {"port":"...","checksum":"...","transport":"...","retry":"unknown","next":"...","decision":"..."},
     "local-32k": {"port":"...","checksum":"...","transport":"...","retry":"unknown","next":"...","decision":"..."},
     "local-131k": {"port":"...","checksum":"...","transport":"...","retry":"...","next":"...","decision":"..."}
   }
   ```

4. Score the saved responses (no model call is made by the scorer):

   ```sh
   FORGE_MEMORY_ANSWERS=/absolute/path/answers.json npm run benchmark:memory
   ```

   PowerShell:

   ```powershell
   $env:FORGE_MEMORY_ANSWERS = 'C:\path\answers.json'
   npm run benchmark:memory
   Remove-Item Env:FORGE_MEMORY_ANSWERS
   ```

The exact-value scorer reports overall correct answers, accuracy on exposed
facts, and abstentions for unexposed facts separately. Mixed old/new transport
answers fail. This is a narrow canary test, not semantic equivalence grading;
it does not establish that an answer file came from a particular model. Record
model/server version, actual context limit, prompt template, temperature, and
reasoning settings separately when comparing runs. Repeat disposable probes to
measure variation; no stochastic provider calls belong in the normal test gate.
