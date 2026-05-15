export const styles = {
  page: {
    minHeight: "100vh",
    background:
      "radial-gradient(circle at 55% 0%, rgba(0,119,255,.18), transparent 32%), radial-gradient(circle at 20% 45%, rgba(0,183,255,.08), transparent 35%), #010915",
    color: "#eaf3ff",
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    overflowX: "hidden",
    overflowY: "auto",
  },
  shell: { display: "flex", minHeight: "100vh" },
  sidebar: {
    width: 268,
    flexShrink: 0,
    borderRight: "1px solid rgba(30,144,255,.22)",
    background: "rgba(2,11,22,.94)",
    padding: "24px 16px",
  },
  main: { flex: 1, padding: "20px 24px", width: "100%", overflowX: "auto" },
  pageHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
    gap: 20,
    flexWrap: "wrap",
  },
  pageTitle: {
    margin: 0,
    fontSize: 30,
    lineHeight: 1.1,
    color: "white",
    fontWeight: 700,
  },
  pageSubtitle: {
    margin: "6px 0 0",
    color: "#9fb0c9",
  },
  panel: {
    border: "1px solid rgba(30,144,255,.32)",
    background: "rgba(3,17,32,.82)",
    borderRadius: 12,
    boxShadow: "inset 0 0 50px rgba(0,70,150,.12)",
  },
};
