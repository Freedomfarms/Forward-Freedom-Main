import { useEffect, useState } from "react";

const SIDEBAR_WIDTH = 268;
const MAIN_PADDING = 48;

function computeDashboardScale(viewportWidth) {
  if (viewportWidth <= 1023) return 1;

  const available = viewportWidth - SIDEBAR_WIDTH - MAIN_PADDING;
  if (available >= 1380) return 1;
  if (available >= 1260) return 0.96;
  if (available >= 1140) return 0.92;
  if (available >= 1020) return 0.88;
  if (available >= 900) return 0.84;
  return 0.8;
}

export function useViewportUIScale() {
  const [scale, setScale] = useState(() =>
    typeof window !== "undefined" ? computeDashboardScale(window.innerWidth) : 1
  );

  useEffect(() => {
    const updateScale = () => setScale(computeDashboardScale(window.innerWidth));
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  return scale;
}
