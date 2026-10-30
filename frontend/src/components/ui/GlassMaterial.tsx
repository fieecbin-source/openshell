import { useEffect, useState } from "react";
import LiquidGlass from "liquid-glass-react";

const STILL = { x: 0, y: 0 };

/** Optical material only: text and controls remain unfiltered siblings. */
export function GlassMaterial({ radius = 18 }: { radius?: number }) {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  if (reduced) return null;
  return (
    <div className="glass-material" aria-hidden="true" data-glass-library="liquid-glass-react">
      <LiquidGlass className="liquid-library" overLight mode="standard" cornerRadius={radius}
        displacementScale={12} aberrationIntensity={0} elasticity={0} blurAmount={0.1} saturation={115}
        globalMousePos={STILL} mouseOffset={STILL} padding="0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <div className="glass-size-probe" />
      </LiquidGlass>
    </div>
  );
}
