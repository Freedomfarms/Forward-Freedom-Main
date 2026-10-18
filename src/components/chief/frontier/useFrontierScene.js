import { useEffect, useRef } from "react";
import { createFrontierScene } from "./frontierScene.js";

export function useFrontierScene({
  rootRef,
  canvasRef,
  anchorRef,
  stageRef,
  activity,
  paused,
  reduced,
}) {
  const sceneRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const anchor = anchorRef.current;
    const stage = stageRef.current;
    const root = rootRef.current;
    if (!canvas || !anchor || !stage || !root) return undefined;
    const scene = createFrontierScene({
      canvas,
      anchor,
      stage,
      root,
      reduced,
      paused,
    });
    scene.setActivity(activity);
    sceneRef.current = scene;
    return () => {
      scene.destroy();
      if (sceneRef.current === scene) sceneRef.current = null;
    };
    // The scene is created once. Activity, pause, and reduced motion sync below
    // so a status change does not rebuild the canvas loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorRef, canvasRef, rootRef, stageRef]);

  useEffect(() => {
    sceneRef.current?.setActivity(activity);
  }, [activity]);

  useEffect(() => {
    sceneRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    sceneRef.current?.setReduced(reduced);
  }, [reduced]);
}
