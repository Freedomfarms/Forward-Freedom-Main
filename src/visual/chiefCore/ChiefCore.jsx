import { useEffect, useRef, useState } from "react";
import { ChiefCoreEngine } from "./ChiefCoreScene.js";
import { stateFromSearch, supportsWebGL } from "./ChiefCoreState.js";
import "./chiefCore.css";

export default function ChiefCore({ state = "idle", layout = "home", preview = false }) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const onFatalRef = useRef(() => {});
  const [forced] = useState(() => stateFromSearch(window.location.search));
  const [webgl] = useState(() => supportsWebGL());
  const [failed, setFailed] = useState(false);
  const shown = forced || state;
  const previewOn = preview && !forced;

  useEffect(() => {
    if (!webgl || failed) return undefined;
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return undefined;
    onFatalRef.current = () => setFailed(true);
    const engine = ChiefCoreEngine.mount(canvas, root, {
      state: shown,
      layout,
      preview: previewOn,
      onFatal: () => onFatalRef.current(),
    });
    if (!engine) return undefined;
    engineRef.current = engine;
    engine.start();
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // The engine is created once. Later props go through the setters below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, webgl]);

  useEffect(() => {
    engineRef.current?.setState(shown);
  }, [shown]);

  useEffect(() => {
    engineRef.current?.setLayout(layout);
  }, [layout]);

  useEffect(() => {
    engineRef.current?.setPreview(previewOn);
  }, [previewOn]);

  if (!webgl || failed) {
    return (
      <div className="chief-core chief-core--fallback" aria-hidden="true">
        <div className="chief-core-fallback-orb" />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="chief-core" aria-hidden="true">
      <canvas ref={canvasRef} className="chief-core-canvas" />
      <div className="chief-core-vignette" />
    </div>
  );
}
