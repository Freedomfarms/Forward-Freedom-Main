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
