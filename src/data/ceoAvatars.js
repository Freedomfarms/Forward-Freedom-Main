// Preset avatars for the CEO Agent. Keys are short slugs stored on
// CeoAgentConfig.avatarKey (validated server-side against /^[a-z0-9][a-z0-9_-]{0,63}$/i).
// Purely static — no external image generation or remote assets.

export const CEO_AVATAR_PRESETS = [
  { key: "compass", emoji: "🧭", label: "Compass", color: "#0ea5e9" },
  { key: "rocket", emoji: "🚀", label: "Rocket", color: "#8b5cf6" },
  { key: "owl", emoji: "🦉", label: "Owl", color: "#f59e0b" },
  { key: "shield", emoji: "🛡️", label: "Shield", color: "#10b981" },
  { key: "lighthouse", emoji: "🗼", label: "Lighthouse", color: "#38bdf8" },
  { key: "mountain", emoji: "⛰️", label: "Mountain", color: "#64748b" },
  { key: "bolt", emoji: "⚡", label: "Bolt", color: "#facc15" },
  { key: "telescope", emoji: "🔭", label: "Telescope", color: "#a855f7" },
  { key: "anchor", emoji: "⚓", label: "Anchor", color: "#14b8a6" },
  { key: "falcon", emoji: "🦅", label: "Falcon", color: "#ef4444" },
  { key: "atlas", emoji: "🌐", label: "Atlas", color: "#3b82f6" },
  { key: "beacon", emoji: "💡", label: "Beacon", color: "#fb7185" },
];

export const DEFAULT_CEO_AVATAR = CEO_AVATAR_PRESETS[0];

/** Resolves a stored avatarKey to its preset; unknown/null keys get the default. */
export function getCeoAvatarPreset(avatarKey) {
  return CEO_AVATAR_PRESETS.find((preset) => preset.key === avatarKey) || DEFAULT_CEO_AVATAR;
}
