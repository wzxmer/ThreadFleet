import type { CSSProperties } from "react";

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

export function ModelActivityCore({ state, size = 22 }: ModelActivityCoreProps) {
  const isCompact = size <= 22;
  const style = {
    width: size,
    height: size,
    "--model-activity-color": STATE_COLORS[state].join(", "),
  } as CSSProperties;

  return (
    <svg
      className={`model-activity-core model-activity-core--${state} ${
        isCompact ? "model-activity-core--compact" : ""
      }`}
      data-state={state}
      viewBox="0 0 100 100"
      style={style}
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="model-activity-core__aura" cx="50" cy="50" r="41" />
      <g className="model-activity-core__orbit model-activity-core__orbit--primary">
        <circle className="model-activity-core__track" cx="50" cy="50" r="30" />
        <circle className="model-activity-core__sweep" cx="50" cy="50" r="30" />
        <circle
          className="model-activity-core__spark model-activity-core__spark--primary"
          cx="80"
          cy="50"
          r="2.25"
        />
      </g>
      <g className="model-activity-core__orbit model-activity-core__orbit--secondary">
        <circle
          className="model-activity-core__track model-activity-core__track--secondary"
          cx="50"
          cy="50"
          r="37"
        />
        <circle
          className="model-activity-core__sweep model-activity-core__sweep--secondary"
          cx="50"
          cy="50"
          r="37"
        />
        <circle
          className="model-activity-core__spark model-activity-core__spark--secondary"
          cx="87"
          cy="50"
          r="1.65"
        />
      </g>
      <circle
        className="model-activity-core__ripple model-activity-core__ripple--one"
        cx="50"
        cy="50"
        r="18"
      />
      <circle
        className="model-activity-core__ripple model-activity-core__ripple--two"
        cx="50"
        cy="50"
        r="18"
      />
      <circle className="model-activity-core__halo" cx="50" cy="50" r="13.5" />
      <circle className="model-activity-core__center" cx="50" cy="50" r="6.4" />
      <circle className="model-activity-core__highlight" cx="47.6" cy="46.8" r="2.1" />
      <g className="model-activity-core__thinking-dots">
        <circle className="model-activity-core__thinking-dot model-activity-core__thinking-dot--one" cx="42" cy="50" r="2.1" />
        <circle className="model-activity-core__thinking-dot model-activity-core__thinking-dot--two" cx="50" cy="50" r="2.1" />
        <circle className="model-activity-core__thinking-dot model-activity-core__thinking-dot--three" cx="58" cy="50" r="2.1" />
      </g>
    </svg>
  );
}
