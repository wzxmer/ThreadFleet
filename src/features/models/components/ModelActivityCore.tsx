import { useEffect, useRef } from "react";

export type ModelActivityState =
  | "idle"
  | "thinking"
  | "executing"
  | "waiting"
  | "completed"
  | "failed";

type ModelActivityCoreProps = {
  state: ModelActivityState;
  size?: number;
};

type RgbColor = [number, number, number];

const STATE_COLORS: Record<ModelActivityState, RgbColor> = {
  idle: [92, 218, 241],
  thinking: [87, 226, 255],
  executing: [70, 242, 220],
  waiting: [255, 184, 85],
  completed: [96, 235, 173],
  failed: [255, 100, 124],
};

const pseudoRandom = (index: number, salt: number) => {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

const rgba = (color: RgbColor, alpha: number) =>
  `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;

export function ModelActivityCore({ state, size = 22 }: ModelActivityCoreProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof CanvasRenderingContext2D === "undefined") {
      return undefined;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * pixelRatio);
    canvas.height = Math.round(size * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const color = STATE_COLORS[state];
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const particles = Array.from({ length: 24 }, (_, index) => ({
      angle: pseudoRandom(index, 1) * Math.PI * 2,
      radius: 0.58 + pseudoRandom(index, 2) * 0.42,
      phase: pseudoRandom(index, 3) * Math.PI * 2,
      drift: (0.5 + pseudoRandom(index, 4) * 0.9) * (index % 2 ? 1 : -1),
      size: 0.45 + pseudoRandom(index, 5) * 1.25,
      depth: 0.35 + pseudoRandom(index, 6) * 0.65,
    }));
    const startedAt = performance.now();
    let animationFrame = 0;

    const render = (timestamp: number) => {
      const elapsed = reducedMotion ? 0 : timestamp - startedAt;
      const time = elapsed / 1000;
      const center = size / 2;
      const baseRadius = size * 0.25;
      const outerLimit = size * 0.45;
      const stateSpeed =
        state === "executing"
          ? 2.2
          : state === "waiting"
            ? 0.12
            : state === "thinking"
              ? 0
              : 0.28;
      const pulse = reducedMotion
        ? 0
        : Math.sin(time * (state === "executing" ? 5.8 : 2.1));
      const completionProgress = Math.min(1, elapsed / 850);
      const failureProgress = Math.min(1, elapsed / 650);

      context.clearRect(0, 0, size, size);
      context.save();
      context.translate(center, center);
      context.globalCompositeOperation = "lighter";

      const aura = context.createRadialGradient(0, 0, 0, 0, 0, outerLimit);
      aura.addColorStop(0, rgba(color, state === "idle" ? 0.24 : 0.38));
      aura.addColorStop(0.38, rgba(color, state === "executing" ? 0.15 : 0.09));
      aura.addColorStop(1, rgba(color, 0));
      context.fillStyle = aura;
      context.beginPath();
      context.arc(0, 0, outerLimit, 0, Math.PI * 2);
      context.fill();

      particles.forEach((particle, index) => {
        let radius = baseRadius * particle.radius;
        let angle = particle.angle + time * stateSpeed * particle.drift;
        let alpha = 0.24 + particle.depth * 0.56;
        let activity = 0;

        if (state === "thinking") {
          const bandCount = 12;
          const layerCount = Math.ceil(particles.length / bandCount);
          const band = index % bandCount;
          const layer = Math.floor(index / bandCount);
          const layerProgress = (layer + 0.72) / (layerCount + 0.28);
          const angularSpacing = Math.PI * 2 / bandCount;
          angle =
            band * angularSpacing +
            (pseudoRandom(index, 10) - 0.5) * angularSpacing * 0.28;
          const primaryBand = (Math.sin(time * 5.6 + band * 0.82) + 1) * 0.5;
          const secondaryBand =
            (Math.sin(time * 8.4 - band * 1.31 + 1.4) + 1) * 0.5;
          const spectrumLevel =
            Math.pow(primaryBand * 0.62 + secondaryBand * 0.38, 1.45) *
            (0.76 + pseudoRandom(band, 11) * 0.24);
          radius = baseRadius * (0.48 + layerProgress * 0.5);
          radius += size * 0.09 * spectrumLevel * (0.38 + layerProgress * 0.72);
          alpha = 0.3 + particle.depth * 0.5 + spectrumLevel * 0.24;
          activity = spectrumLevel;
        } else if (state === "executing") {
          const burstPhase = (time * 0.72 + particle.phase / (Math.PI * 2)) % 1;
          const burst = Math.sin(burstPhase * Math.PI);
          radius += burst * size * (0.11 + particle.depth * 0.11);
          angle += Math.sin(time * 4.2 + particle.phase) * 0.12;
          alpha = 0.42 + particle.depth * 0.58;
        } else if (state === "waiting") {
          radius += size * 0.085 + Math.sin(time * 0.9 + particle.phase) * size * 0.009;
          alpha = 0.35 + particle.depth * 0.45;
        } else if (state === "completed") {
          const collapse = reducedMotion ? 1 : 1 - Math.pow(1 - completionProgress, 3);
          radius *= 1.45 - collapse * 0.55;
          alpha *= 0.7 + collapse * 0.3;
        } else if (state === "failed") {
          const jitter =
            reducedMotion || failureProgress >= 1
              ? 0
              : (1 - failureProgress) * size * 0.035;
          radius += Math.sin(index * 2.7 + time * 28) * jitter;
          angle += Math.sin(index + time * 34) * (1 - failureProgress) * 0.09;
        } else {
          radius += pulse * size * 0.008 * particle.depth;
          alpha *= 0.68;
        }

        const perspective = 0.72 + Math.sin(angle + particle.phase) * 0.28;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius * 0.74;
        const dotSize = Math.max(
          0.42,
          particle.size * 0.48 * perspective * (1 + activity * 0.28),
        );
        context.fillStyle = rgba(color, alpha * perspective);
        context.shadowColor = rgba(color, 0.75);
        context.shadowBlur = 2;
        context.beginPath();
        context.arc(x, y, dotSize, 0, Math.PI * 2);
        context.fill();
      });

      const ringRotation =
        reducedMotion || state === "thinking"
          ? 0
          : time * (state === "executing" ? 2.2 : 0.08);
      const ringRadius = size * 0.34;
      context.shadowBlur = 2;
      context.lineWidth = 1.25;
      context.lineCap = "round";
      context.strokeStyle = rgba(
        color,
        state === "idle" ? 0.52 : state === "thinking" ? 0.5 : 0.8,
      );
      context.beginPath();
      context.arc(0, 0, ringRadius, ringRotation + 0.25, ringRotation + 2.1);
      context.stroke();
      context.strokeStyle = rgba(
        color,
        state === "idle" ? 0.24 : state === "thinking" ? 0.25 : 0.48,
      );
      context.beginPath();
      context.arc(
        0,
        0,
        ringRadius * 1.12,
        -ringRotation * 0.62 + 2.75,
        -ringRotation * 0.62 + 5.4,
      );
      context.stroke();

      if (state === "completed" && completionProgress < 1) {
        const waveRadius = size * (0.18 + completionProgress * 0.26);
        context.lineWidth = 1;
        context.strokeStyle = rgba(color, (1 - completionProgress) * 0.72);
        context.beginPath();
        context.arc(0, 0, waveRadius, 0, Math.PI * 2);
        context.stroke();
      }

      const corePulse = state === "thinking" ? 0 : pulse;
      const corePulseAmount = state === "idle" ? 0.018 : 0.04;
      const coreRadius = size * 0.17 * (1 + corePulse * corePulseAmount);
      const core = context.createRadialGradient(
        -coreRadius * 0.22,
        -coreRadius * 0.25,
        0,
        0,
        0,
        coreRadius * 1.35,
      );
      core.addColorStop(0, "rgba(235, 253, 255, .96)");
      core.addColorStop(0.18, rgba(color, 0.92));
      core.addColorStop(0.58, rgba(color, 0.36));
      core.addColorStop(1, rgba(color, 0));
      context.shadowColor = rgba(color, 0.85);
      context.shadowBlur = 4;
      context.fillStyle = core;
      context.beginPath();
      context.arc(0, 0, coreRadius * 1.35, 0, Math.PI * 2);
      context.fill();

      context.restore();
      if (!reducedMotion) {
        animationFrame = window.requestAnimationFrame(render);
      }
    };

    render(performance.now());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [size, state]);

  return (
    <canvas
      ref={canvasRef}
      className="model-activity-core"
      data-state={state}
      width={size * 2}
      height={size * 2}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
