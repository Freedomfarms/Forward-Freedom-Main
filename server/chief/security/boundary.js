// CHIEF boundary guard — outbound tool calls.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source file: src/openjarvis/security/boundary.py (BoundaryGuard.check_outbound)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Upstream's default scanners are Rust-only (security/scanner.py). If that
// import fails, BoundaryGuard keeps an empty scanner list and block mode
// finds nothing, so the call proceeds. CHIEF does not copy that fail-open.
// Until those patterns are ported on purpose, block mode refuses every
// non-local tool. Local tools are unchanged. There is no redact/warn mode
// here, because an empty pattern list cannot redact.

export class BoundaryGuard {
  constructor({ mode = "block" } = {}) {
    if (mode !== "block") {
      throw new TypeError(
        "boundary guard only supports block mode until scanner patterns are ported"
      );
    }
    this.mode = mode;
  }

  check(tool) {
    if (tool?.isLocal !== false) return { allow: true };
    const name = tool?.spec?.name ?? "unknown";
    return {
      allow: false,
      output:
        `boundary guard blocked non-local tool '${name}' ` +
        "(scanner patterns are not ported; block mode refuses outbound calls)",
    };
  }
}
