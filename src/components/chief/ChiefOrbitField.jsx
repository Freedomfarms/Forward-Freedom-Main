import { useEffect, useRef, useState } from "react";
import { CHIEF_ORBIT, orbitNodePosition, splitChiefOrbitLayers } from "./chiefOrbit.js";

function paint(canvas, pixels, width, height) {
  if (!canvas) return;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
}

function Nodes({ nodes }) {
  return nodes.map((node) => (
    <i
      key={`${node.radius}-${node.angle}`}
      className="chief-orbit-node"
      style={orbitNodePosition(node)}
    />
  ));
}

export function ChiefOrbitField({ src }) {
  const baseRef = useRef(null);
  const innerRef = useRef(null);
  const outerRef = useRef(null);
  const beamRef = useRef(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      if (image.naturalWidth !== CHIEF_ORBIT.width || image.naturalHeight !== CHIEF_ORBIT.height) {
        return;
      }
      const scratch = document.createElement("canvas");
      scratch.width = image.naturalWidth;
      scratch.height = image.naturalHeight;
      const context = scratch.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0);
      const frame = context.getImageData(0, 0, scratch.width, scratch.height);
      const layers = splitChiefOrbitLayers(frame.data, frame.width, frame.height);
      if (!layers || cancelled) return;
      paint(baseRef.current, layers.base, frame.width, frame.height);
      paint(innerRef.current, layers.inner, frame.width, frame.height);
      paint(outerRef.current, layers.outer, frame.width, frame.height);
      paint(beamRef.current, layers.beam, frame.width, frame.height);
      setLive(true);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div className={live ? "chief-orbit-field is-live" : "chief-orbit-field"} aria-hidden="true">
      <canvas ref={baseRef} className="chief-scene-base" />
      <div
        className="chief-orbit-layer chief-orbit-outer"
        style={{ animationDuration: `${CHIEF_ORBIT.outerSeconds}s` }}
      >
        <canvas ref={outerRef} />
        <Nodes nodes={CHIEF_ORBIT.nodes.outer} />
      </div>
      <div
        className="chief-orbit-layer chief-orbit-inner"
        style={{ animationDuration: `${CHIEF_ORBIT.innerSeconds}s` }}
      >
        <canvas ref={innerRef} />
        <Nodes nodes={CHIEF_ORBIT.nodes.inner} />
      </div>
      <i className="chief-orbit-pulse chief-orbit-pulse-outer" />
      <i className="chief-orbit-pulse chief-orbit-pulse-inner" />
      <canvas ref={beamRef} className="chief-orbit-beam" />
      <i className="chief-core-shimmer" />
    </div>
  );
}
