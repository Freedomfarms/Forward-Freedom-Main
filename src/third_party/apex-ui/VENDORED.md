# Vendored APEX-UI

- Repository: https://github.com/RubenM1990/APEX-UI
- Commit: `a8732fad1078a809cadfa810cb0d89cf4445dbed`
- License: MIT (see `LICENSE` and `licenses/APEX-UI-LICENSE-MIT.txt`)
- Copyright: Copyright (c) 2026 Ruben Mouradian (Reznikov Engineering)

The Next.js app is not vendored. These files are the visual shell:

- `ApexOrb.jsx`
- `ApexHeroOrb.tsx` (Next.js `dynamic` replaced with `React.lazy`)
- `ApexCore3D.jsx`
- `ReasoningWeb.jsx`
- `OrbStatusBar.jsx`
- `ShaderBackground.jsx`
- `apex-orb.css`
- `apex-ui.css` (orb-relevant rules from `app/globals.css`)
- `ApexWorld.jsx` (the `ApexWorld` composition; state and node selection are props)
- `ApexClock.jsx` (time and date from `ApexOverviewPanel`)

`ShaderBackground.jsx` and the lamp-panel design credited in `CREDITS.md` are MIT components from 21st.dev. Keep `CREDITS.md` with any fork of those two pieces.

The product name shown in this app is CHIEF. The APEX name and Reznikov Engineering branding are not used in the interface.
