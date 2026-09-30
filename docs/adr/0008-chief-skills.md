# ADR-0008: A CHIEF skill is a scanned procedure, not a ToolSpec

- Status: proposed with Phase 8
- Date: 2026-09-30
- Supersedes: ADR-0004 decision 2, the sentence that a later skill would itself be a ToolSpec

## Decision

1. A skill is a bundled `SKILL.md`. The frontmatter subset is `name`, `description`,
   `requires_tools`, and `required_capabilities`. Parsing follows OpenJarvis
   `SkillManifest` / `load_skill_markdown` and the Hermes `SKILL.md` fence. Unknown
   fields, oversized files, and fenced bodies are refused. Hermes warns and still
   loads a scanned file. CHIEF does not.
2. The skill index is rendered by the existing `assembleSystemPrompt`. It is the
   Hermes compact `<available_skills>` block. `requires_tools` hides a skill when
   the turn does not have that tool, which is `_skill_should_show`.
   `required_capabilities` hides a skill when the session policy does not grant
   them, which is OpenJarvis `validate_capabilities` used as an offer filter.
   Neither field grants anything.
3. The only new tool is `skill_view`. It is inventoried as `skill:read`, local,
   and not a confirmation. `ToolExecutor` is the only caller. The tool returns
   the procedure text. It does not call another tool, invoke the executor, or
   start a model loop.
4. A procedure may name `finance_summary`, `workspace_plan_summary`, or a
   confirming tool. The model must emit an ordinary tool call. `TurnMachine._authorize`
   and `ToolExecutor` stay on that call. A scheduled turn uses the same path.
   There is no skill runner, no per-skill ToolSpec, and no second scheduler.
5. Skills are files in this repository. There is no skill table.

## Consequences

ADR-0004's gate order is unchanged. `skill_view` is one more inventoried read.
OpenJarvis `SkillExecutor` and Hermes shell preprocessing stay unused. User-authored
skills, event triggers, and skill text in `compaction.handoff` stay deferred.
