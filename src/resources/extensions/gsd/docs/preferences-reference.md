# GSD Preferences Reference

Full documentation for `~/.gsd/preferences.md` (global) and `.gsd/preferences.md` (project).

---

## Notes

- Keep this skill-first.
- Prefer explicit skill names or absolute paths.
- Use absolute paths for personal/local skills when you want zero ambiguity.
- These preferences guide which skills GSD should load and follow; they do not override higher-priority instructions in the current conversation.

---

## Field Guide

- `version`: schema version. Start at `1`.

- `always_use_skills`: skills GSD should use whenever they are relevant.

- `prefer_skills`: soft defaults GSD should prefer when relevant.

- `avoid_skills`: skills GSD should avoid unless clearly needed.

- `skill_rules`: situational rules with a human-readable `when` trigger and one or more of `use`, `prefer`, or `avoid`.

- `custom_instructions`: extra durable instructions related to skill use.

- `models`: per-stage model selection for auto-mode. Keys: `research`, `planning`, `execution`, `completion`. Each key accepts either:
  - a model ID string, e.g. `claude-sonnet-4-6`
  - an object, e.g. `{ model: claude-opus-4-6, fallbacks: [openrouter/z-ai/glm-5] }`
  Omit a key to use whatever model is currently active.

- `skill_discovery`: controls how GSD discovers and applies skills during auto-mode. Valid values:
  - `auto` — skills are found and applied automatically without prompting.
  - `suggest` — (default) skills are identified during research but not installed automatically.
  - `off` — skill discovery is disabled entirely.

- `auto_supervisor`: configures the auto-mode supervisor that monitors agent progress and enforces timeouts. Keys:
  - `model`: model ID to use for the supervisor process (defaults to the currently active model).
  - `soft_timeout_minutes`: minutes before the supervisor issues a soft warning (default: 20).
  - `idle_timeout_minutes`: minutes of inactivity before the supervisor intervenes (default: 10).
  - `hard_timeout_minutes`: minutes before the supervisor forces termination (default: 30).

- `secrets`: proactive secret preparation for auto-mode. Keys:
  - `proactive_collect`: boolean — when `true`, auto-mode checks a milestone secrets manifest before first dispatch and collects only missing keys. Default: `false`.

- `git`: configures GSD's git behavior. All fields are optional. Keys:
  - `auto_push`: boolean — automatically push commits after committing. Default: `false`.
  - `push_branches`: boolean — push newly created slice branches to the remote. Default: `false`.
  - `remote`: string — git remote name to push to. Default: `"origin"`.
  - `snapshots`: boolean — create snapshot refs before destructive merge operations. Default: `false`.
  - `pre_merge_check`: boolean, `"auto"`, or a command string — run a verification step before finalizing a slice merge. Default: auto-detect when enabled.
  - `commit_type`: string — override the conventional commit prefix used for slice merges. Allowed: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `style`.
  - `main_branch`: string — preferred primary branch name when detection is ambiguous or when initializing new repos.

---

## Best Practices

- Keep `always_use_skills` short.
- Use `skill_rules` for situational routing, not broad personality preferences.
- Prefer skill names for stable built-in skills.
- Prefer absolute paths for local personal skills.

---

## Models Example

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/minimax/minimax-m2.5
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
---
```

Opus for planning, Sonnet for everything else, and ordered fallbacks when the primary planning model is unavailable. Omit any key to use the currently selected model.

---

## Secrets Example

```yaml
---
version: 1
secrets:
  proactive_collect: true
---
```

When enabled, GSD looks for `M###-SECRETS.md` before the first auto-mode dispatch of that milestone and only prompts for keys that are still missing.

---

## Example Variations

**Minimal — always load a UAT skill and route Clerk tasks:**

```yaml
---
version: 1
always_use_skills:
  - /Users/you/.claude/skills/verify-uat
skill_rules:
  - when: finishing implementation and human judgment matters
    use:
      - /Users/you/.claude/skills/verify-uat
---
```

**Richer routing — prefer cleanup and authentication skills:**

```yaml
---

## Git Preferences Example

```yaml
---
version: 1
git:
  auto_push: true
  push_branches: true
  remote: origin
  snapshots: true
  pre_merge_check: auto
  commit_type: feat
  main_branch: main
---
```

All git fields are optional. Project-level preferences override global preferences on a per-field basis.
version: 1
prefer_skills:
  - commit-ignore
skill_rules:
  - when: task involves Clerk authentication
    use:
      - clerk
      - clerk-setup
  - when: the user is looking for installable capability rather than implementation
    prefer:
      - find-skills
---
```
