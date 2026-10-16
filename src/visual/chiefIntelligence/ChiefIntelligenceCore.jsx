import { useEffect, useRef, useState } from "react";
import { ChiefIntelligenceEngine } from "./ChiefIntelligenceEngine.js";
import { supportsWebGL } from "../chiefCore/ChiefCoreState.js";

export function ChiefIntelligenceCore({ state = "idle" }) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const onFatalRef = useRef(() => {});
  const [webgl] = useState(() => supportsWebGL());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!webgl || failed) return undefined;
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return undefined;
    onFatalRef.current = () => setFailed(true);
    const engine = ChiefIntelligenceEngine.mount(canvas, root, {
      state,
      onFatal: () => onFatalRef.current(),
    });
    if (!engine) return undefined;
    engineRef.current = engine;
    engine.start();
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // The engine is created once. Later state goes through setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, webgl]);

  useEffect(() => {
    engineRef.current?.setState(state);
  }, [state]);

  if (!webgl || failed) return null;

  return (
    <div ref={rootRef} className="chief-intelligence-core">
      <canvas ref={canvasRef} />
    </div>
  );
}
