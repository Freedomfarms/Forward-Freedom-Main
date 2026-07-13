import { Component } from "react";

const defaultFallbackStyle = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  padding: 24,
  background:
    "radial-gradient(circle at 20% 20%, rgba(0,136,255,.24), transparent 24%), linear-gradient(180deg, #020711, #041121 72%, #030d1a)",
  color: "#eef6ff",
};

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info);
  }

  handleRetry() {
    this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback({
          error: this.state.error,
          reset: this.handleRetry,
        });
      }

      return (
        <div style={defaultFallbackStyle}>
          <div style={{ maxWidth: 520, textAlign: "center" }}>
            <div
              style={{
                color: "#8feaff",
                textTransform: "uppercase",
                letterSpacing: 1.4,
                fontSize: 12,
                fontWeight: 900,
              }}
            >
              Forward Freedom Financial
            </div>
            <div style={{ marginTop: 12, fontSize: 28, fontWeight: 900 }}>
              Something went wrong loading this screen.
            </div>
            <p style={{ marginTop: 16, color: "#9fb0c9", lineHeight: 1.6, fontSize: 15 }}>
              Your session is still safe. Try again, or refresh the page if the problem continues.
            </p>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{
                marginTop: 22,
                borderRadius: 10,
                border: "1px solid rgba(125,220,255,.45)",
                background: "linear-gradient(90deg,#0077ff,#00aaff)",
                color: "white",
                padding: "12px 20px",
                cursor: "pointer",
                fontWeight: 800,
                fontSize: 14,
              }}
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// View-scoped boundary for the main dashboard tabs. A throw inside one view
// (Accounts, Budget Lab, Transactions, ...) renders this inline panel in the
// content area instead of blanking the whole app; the sidebar stays usable so
// the user can retry or move to another tab. Mount it with key={activeTab} so
// switching tabs automatically clears a previous view's error state.
export function ViewErrorBoundary({ viewName, children }) {
  return (
    <ErrorBoundary
      fallback={({ reset }) => (
        <div
          style={{
            border: "1px solid rgba(255,93,122,.32)",
            borderRadius: 18,
            background: "rgba(3,17,32,.72)",
            padding: "42px 32px",
            margin: "24px 0",
            textAlign: "center",
            color: "#eef6ff",
          }}
        >
          <div
            style={{
              color: "#ff8fa3",
              textTransform: "uppercase",
              letterSpacing: 1.4,
              fontSize: 12,
              fontWeight: 900,
            }}
          >
            {viewName ? `${viewName} hit an error` : "This view hit an error"}
          </div>
          <div style={{ marginTop: 12, fontSize: 24, fontWeight: 900 }}>
            This screen could not render, but the rest of the app is fine.
          </div>
          <p style={{ marginTop: 14, color: "#9fb0c9", lineHeight: 1.6, fontSize: 14 }}>
            Your data is safe. Try again, or use the sidebar to open a different view while we
            recover.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 20,
              borderRadius: 10,
              border: "1px solid rgba(125,220,255,.45)",
              background: "linear-gradient(90deg,#0077ff,#00aaff)",
              color: "white",
              padding: "11px 18px",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            Try Again
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
