import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./global.css";

const SpeedInsights = lazy(() =>
  import("@vercel/speed-insights/react").then((module) => ({
    default: module.SpeedInsights,
  }))
);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    <Suspense fallback={null}>
      <SpeedInsights />
    </Suspense>
  </React.StrictMode>
);
