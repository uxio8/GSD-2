You are executing GSD auto-mode.

## UNIT: Plan Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

All relevant context has been preloaded below — start working immediately without re-reading these files.

{{inlinedContext}}

### Dependency Slice Summaries

Pay particular attention to **Forward Intelligence** sections — they contain hard-won knowledge about what's fragile, what assumptions changed, and what this slice should watch out for.

{{dependencySummaries}}

Narrate your decomposition reasoning — why you're grouping work this way, what risks are driving the order, and what verification strategy you're choosing. Keep the narration proportional to the work. A simple slice does not need a long justification.

**Right-size the plan.** If the slice is simple enough to be 1 task, plan 1 task. Do not split work just because you can identify sub-steps. Do not fill optional sections with "None" when they do not apply — omit them entirely.

Then:
0. If `REQUIREMENTS.md` was preloaded above, identify which Active requirements the roadmap says this slice owns or supports. These are the requirements this plan must deliver — every owned requirement needs at least one task that directly advances it, and verification must prove the requirement is met.
1. Read the templates:
   - `~/.gsd/agent/extensions/gsd/templates/plan.md`
   - `~/.gsd/agent/extensions/gsd/templates/task-plan.md`
2. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during planning, without overriding required plan formatting
3. Define slice-level verification first — the objective stopping condition for this slice:
   - For non-trivial slices: plan actual test files with real assertions. Name the files.
   - For simple slices: executable commands or script assertions are fine.
   - If the project is non-trivial and has no test framework, the first task should set one up.
   - If this slice establishes a boundary contract, verification must exercise that contract.
4. For non-trivial slices only, plan observability, proof level, and integration closure:
   - Include `Observability / Diagnostics` for backend, integration, async, stateful, or UI slices where failure diagnosis matters.
   - Fill `Proof Level` and `Integration Closure` when the slice crosses runtime boundaries or has meaningful integration concerns.
   - Omit these sections entirely for simple slices where they would all be trivial or empty.
5. Decompose the slice into tasks, each fitting one context window.
6. Every task in the slice plan should be written as an executable increment with:
   - a concrete, action-oriented title
   - the inline task entry fields defined in the plan.md template (Why / Files / Do / Verify / Done when)
   - a matching task plan containing description, steps, must-haves, verification, inputs, and expected output
   - an `Observability Impact` section only if the task changes runtime boundaries, async flows, APIs, background processes, or error paths
7. If verification includes test files, ensure the first task includes creating them with expected assertions. They should fail initially.
8. Write `{{outputPath}}`
9. Write individual task plans in `{{sliceAbsPath}}/tasks/`: `T01-PLAN.md`, `T02-PLAN.md`, etc.
10. **Self-audit the plan before continuing.** Walk through each check — if any fail, fix the plan files before moving on:
    - **Completion semantics:** If every task were completed exactly as written, the slice goal/demo should actually be true.
    - **Requirement coverage:** Every must-have in the slice maps to at least one task. No must-have is orphaned.
    - **Task completeness:** Every task has steps, must-haves, verification, inputs, and expected output. If a task includes `Observability Impact`, it must be concrete too.
    - **Dependency correctness:** Task ordering is consistent. No task references work from a later task.
    - **Key links planned:** For every pair of artifacts that must connect (component → API, API → database, form → handler), there is an explicit step that wires them — not just "create X" and "create Y" in separate tasks with no connection step.
    - **Scope sanity:** Target 2–5 steps and 3–8 files per task. 6–8 steps or 8–10 files is a warning — consider splitting. 10+ steps or 12+ files — must split. Each task must be completable in a single fresh context window.
    - **Context compliance:** If context/research artifacts or `.gsd/DECISIONS.md` exist, the plan honors locked decisions and doesn't include deferred or out-of-scope items.
    - **Requirement coverage:** If `REQUIREMENTS.md` exists, every Active requirement this slice owns (per the roadmap) maps to at least one task with verification that proves the requirement is met. No owned requirement is left without a task. No task claims to satisfy a requirement that is Deferred or Out of Scope.
    - **Proof honesty:** If `Proof Level` and `Integration Closure` are present, they match what this slice will actually prove and they do not imply live end-to-end completion if only fixture or contract proof is planned.
    - **Feature completeness:** Every task produces real, user-facing progress — not just internal scaffolding. If the slice has a UI surface, at least one task builds the real UI (not a placeholder). If the slice has an API, at least one task connects it to a real data source (not hardcoded returns). If every task were completed and you showed the result to a non-technical stakeholder, they should see real product progress, not developer artifacts.
11. If planning produced structural decisions (e.g. verification strategy, observability strategy, technology choices, patterns to follow), append them to `.gsd/DECISIONS.md`
12. Do not commit manually — the system auto-commits your changes after this unit completes.
13. Update `.gsd/STATE.md`

The slice directory and tasks/ subdirectory already exist. Do NOT mkdir. You are on the slice branch; all work stays here.

**You MUST write the file `{{outputAbsPath}}` before finishing.**

When done, say: "Slice {{sliceId}} planned."
