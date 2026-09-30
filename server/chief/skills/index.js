// CHIEF skill index — names and descriptions offered to one model call.
//
// PORT/ADAPT of Hermes Agent (MIT)
//   Upstream: https://github.com/NousResearch/hermes-agent
//   Source file: agent/prompt_builder.py (_skill_should_show,
//     _render_skills_index, build_skills_system_prompt)
//   Commit: 8c30ef318d1ed6c88597239081f5749268efdca8
//
// Preserved:
//   - the index is a compact <available_skills> block, not the skill body
//   - requires_tools hides a skill when one of those tools is absent
//   - when no tool list is supplied, the tool filter does not run
// And of OpenJarvis skills/security.py validate_capabilities (commit 5e5f5ef):
//   required_capabilities are compared to what the session was granted.
//   A missing capability hides the offer. It does not grant the capability.
// Adaptations:
//   - CHIEF has no toolsets, platforms, or fallback_for_tools.
//   - The prose does not mention skill_manage, shell, or a second loop.
//   - OpenJarvis get_catalog_xml is the same catalog idea; CHIEF uses the
//     Hermes text block because the system prompt is already one string.

export function skillShouldShow(skill, { availableTools = null, capabilityPolicy = null } = {}) {
  if (availableTools != null) {
    const tools = availableTools instanceof Set ? availableTools : new Set(availableTools);
    if (skill.requiresTools.some((name) => !tools.has(name))) return false;
  }
  if (capabilityPolicy) {
    for (const capability of skill.requiredCapabilities) {
      if (!capabilityPolicy.check("chief", capability, skill.name)) return false;
    }
  }
  return true;
}

export function renderSkillsIndex(skills, options = {}) {
  const visible = (skills ?? []).filter((skill) => skillShouldShow(skill, options));
  if (visible.length === 0) return "";
  const lines = [...visible]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => `  - ${skill.name}: ${skill.description}`);
  return [
    "## Skills",
    "Before replying, scan the skills below. If one clearly matches the task, load it with skill_view(name) and follow its instructions. A loaded skill is a procedure, not a permission. Tools it names still go through the normal capability and approval checks.",
    "",
    "<available_skills>",
    ...lines,
    "</available_skills>",
    "",
    "Only proceed without loading a skill if none are relevant to the task.",
  ].join("\n");
}
