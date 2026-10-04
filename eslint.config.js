import path from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

// ─────────────────────────────────────────────────────────────────────────────
// CHIEF (Module 03) import boundaries — docs/CHIEF_ARCHITECTURE.md §4.
//
// CHIEF is architecturally independent of Module 01 (CEO Agents) and Module 02
// (Freedom Financial). These rules make the boundary mechanical: they resolve
// every relative import to a real file path and fail the lint if it crosses a
// forbidden boundary, in either direction. Bare specifiers (npm packages) are
// never affected. The zones reference directories that may not exist yet; the
// rules are intentionally in place BEFORE any CHIEF code so the boundary is
// enforced from the first file onward.
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const rp = (...segments) => path.resolve(repoRoot, ...segments);

// A resolved import matches a target if it IS the target, lives under it as a
// directory, or is the target with a file extension (so "api/agents" matches
// both api/agents.js and api/agents/).
function matchesTarget(target, resolved) {
  return (
    resolved === target ||
    resolved.startsWith(target + path.sep) ||
    resolved.startsWith(target + ".")
  );
}

function fileInZone(zone, filename) {
  return matchesTarget(zone, filename);
}

// Boundary map. `zones` are the files being linted; `forbidden` are resolved
// import targets those files may never reach.
const CHIEF_BOUNDARIES = [
  {
    // CHIEF server + API code must not touch Module 01 server code or handlers.
    zones: [rp("server/chief"), rp("api/chief")],
    // Plain-prefix zones: matches api/cron/chief-dispatch.js and any future
    // api/cron/chief-*.js endpoints.
    zonePrefixes: [rp("api/cron/chief")],
    forbidden: [
      {
        targets: [
          rp("server/brain"),
          rp("server/agents"),
          rp("server/memory"),
          rp("server/capabilities"),
          rp("api/agents"),
          rp("api/notifications"),
        ],
        message: "CHIEF must not import Module 01 server code (docs/CHIEF_ARCHITECTURE.md §4).",
      },
      {
        targets: [rp("src/components")],
        message: "CHIEF server code must not import UI components (docs/CHIEF_ARCHITECTURE.md §4).",
      },
    ],
  },
  {
    // CHIEF UI must not import Module 01 UI or Module 01 client plumbing.
    zones: [rp("src/components/chief")],
    forbidden: [
      {
        targets: [
          rp("src/components/freedomOs"),
          rp("src/utils/agentsApi"),
          rp("src/hooks/useFreedomOsBootstrap"),
          rp("src/ForwardFreedomDashboard"),
        ],
        message:
          "CHIEF UI must not import Module 01 UI or client plumbing (docs/CHIEF_ARCHITECTURE.md §4).",
      },
      {
        targets: [rp("server")],
        message: "CHIEF UI must not import server code (docs/CHIEF_ARCHITECTURE.md §4).",
      },
    ],
  },
  {
    // Vendored third-party code must stay self-contained: it may not reach
    // into the application (docs/CHIEF_ARCHITECTURE.md §7.3 vendoring policy).
    zones: [rp("src/third_party")],
    forbidden: [
      {
        targets: [
          rp("server"),
          rp("api"),
          rp("src/components"),
          rp("src/utils"),
          rp("src/hooks"),
          rp("src/context"),
          rp("src/data"),
        ],
        message:
          "Vendored third_party code must not import application code (docs/CHIEF_ARCHITECTURE.md §7.3).",
      },
    ],
  },
  {
    // Reverse isolation: Module 01 server code must not import CHIEF.
    zones: [
      rp("server/brain"),
      rp("server/agents"),
      rp("server/memory"),
      rp("server/capabilities"),
      rp("api/agents"),
      rp("api/notifications"),
      rp("api/cron/agent-dispatch"),
    ],
    forbidden: [
      {
        targets: [rp("server/chief"), rp("api/chief")],
        message: "Module 01 must not import CHIEF code (docs/CHIEF_ARCHITECTURE.md §4).",
      },
    ],
  },
  {
    // Reverse isolation: Module 01 UI must not import CHIEF UI or vendored code.
    zones: [rp("src/components/freedomOs")],
    forbidden: [
      {
        targets: [rp("src/components/chief"), rp("src/third_party")],
        message:
          "Module 01 UI must not import CHIEF UI or third_party code (docs/CHIEF_ARCHITECTURE.md §4).",
      },
    ],
  },
  {
    // Vendored code is only consumable from CHIEF UI. Everything else in src/
    // (outside CHIEF UI and third_party itself) must not import it.
    zones: [rp("src")],
    zoneExceptions: [rp("src/components/chief"), rp("src/third_party")],
    forbidden: [
      {
        targets: [rp("src/third_party")],
        message:
          "Only CHIEF UI (src/components/chief) may import vendored third_party code (docs/CHIEF_ARCHITECTURE.md §4).",
      },
    ],
  },
];

const chiefBoundariesRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce CHIEF (Module 03) import boundaries — docs/CHIEF_ARCHITECTURE.md §4",
    },
    schema: [],
  },
  create(context) {
    const filename = path.resolve(context.filename ?? context.getFilename());
    const activeBoundaries = CHIEF_BOUNDARIES.filter(
      (boundary) =>
        (boundary.zones.some((zone) => fileInZone(zone, filename)) ||
          (boundary.zonePrefixes || []).some((prefix) => filename.startsWith(prefix))) &&
        !(boundary.zoneExceptions || []).some((zone) => fileInZone(zone, filename))
    );
    if (activeBoundaries.length === 0) return {};

    function checkSource(node, specifier) {
      if (typeof specifier !== "string" || !specifier.startsWith(".")) return;
      const resolved = path.resolve(path.dirname(filename), specifier);
      for (const boundary of activeBoundaries) {
        for (const rule of boundary.forbidden) {
          if (rule.targets.some((target) => matchesTarget(target, resolved))) {
            context.report({ node, message: rule.message });
            return;
          }
        }
      }
    }

    return {
      ImportDeclaration(node) {
        checkSource(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source?.type === "Literal") checkSource(node, node.source.value);
      },
    };
  },
};

const chiefBoundariesPlugin = {
  rules: { "no-cross-module-imports": chiefBoundariesRule },
};

export default [
  {
    ignores: ["dist/", "node_modules/"],
  },
  js.configs.recommended,
  {
    files: ["server/**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // Vendored APEX-UI is copied intact (commit a8732fad). Its simulation
    // writes typed arrays and updates refs during render; that is the upstream
    // animation model, not application code to restyle.
    files: ["src/third_party/**/*.{js,jsx}"],
    rules: {
      "no-empty": "off",
      "no-unused-vars": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // CHIEF (Module 03) import boundaries — applies everywhere; the rule
    // self-filters by zone. See docs/CHIEF_ARCHITECTURE.md §4.
    files: ["**/*.{js,jsx,mjs}"],
    plugins: {
      "chief-boundaries": chiefBoundariesPlugin,
    },
    rules: {
      "chief-boundaries/no-cross-module-imports": "error",
    },
  },
];
