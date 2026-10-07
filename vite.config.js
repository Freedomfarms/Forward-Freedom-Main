import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/firebase")) {
            return "vendor-firebase";
          }
          if (id.includes("node_modules/react-plaid-link") || id.includes("node_modules/plaid")) {
            return "vendor-plaid";
          }
          // Keep the home world and its renderer out of the dashboard chunk so
          // the public backdrop can load the scene without the signed-in app.
          if (
            id.includes("/src/visual/chiefWorld/") ||
            id.includes("node_modules/three/") ||
            id.includes("node_modules/@react-three/") ||
            id.includes("node_modules/postprocessing/")
          ) {
            return "chief-world";
          }
          if (id.includes("/ForwardFreedomDashboard.")) {
            return "dashboard";
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
