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
      aria-hidden="true"
      focusable="false"
    >
      <circle className="model-activity-core__aura" cx="50" cy="50" r="41" />
      <path
        className="model-activity-core__brain-outline model-activity-core__brain-outline--left"
        d="M49 25C42 17 27 19 25 34C17 37 17 52 26 57C23 70 38 78 49 67"
      />
      <path
        className="model-activity-core__brain-outline model-activity-core__brain-outline--right"
        d="M51 25C58 17 73 19 75 34C83 37 83 52 74 57C77 70 62 78 51 67"
      />
      <path
        className="model-activity-core__midline"
        d="M50 25C47 34 53 40 49 49C55 56 51 62 50 68"
      />
      <g className="model-activity-core__network">
        <path
          className="model-activity-core__link model-activity-core__link--one"
          d="M34 43C41 36 47 35 53 40C58 44 62 47 68 42"
        />
        <path
          className="model-activity-core__link model-activity-core__link--two"
          d="M36 58C43 52 49 51 56 55C60 57 64 61 70 58"
        />
        <path
          className="model-activity-core__link model-activity-core__link--three"
          d="M40 34C44 42 43 51 39 60"
        />
        <path
          className="model-activity-core__link model-activity-core__link--four"
          d="M61 34C56 43 58 52 64 62"
        />
        <circle className="model-activity-core__node model-activity-core__node--one" cx="34" cy="43" r="2.4" />
        <circle className="model-activity-core__node model-activity-core__node--two" cx="47" cy="35" r="2.1" />
        <circle className="model-activity-core__node model-activity-core__node--three" cx="68" cy="42" r="2.4" />
        <circle className="model-activity-core__node model-activity-core__node--four" cx="39" cy="60" r="2.2" />
        <circle className="model-activity-core__node model-activity-core__node--five" cx="64" cy="62" r="2.2" />
      </g>
      <g className="model-activity-core__scan">
        <path className="model-activity-core__scan-line" d="M28 48H72" />
      </g>
      <g className="model-activity-core__orbit model-activity-core__orbit--primary">
        <circle className="model-activity-core__track" cx="50" cy="50" r="29" />
        <circle className="model-activity-core__sweep" cx="50" cy="50" r="29" />
        <circle
          className="model-activity-core__spark model-activity-core__spark--primary"
          cx="79"
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
      <circle className="model-activity-core__halo" cx="50" cy="50" r="13" />
      <circle className="model-activity-core__center" cx="50" cy="50" r="6.7" />
      <circle className="model-activity-core__highlight" cx="47.5" cy="47" r="2.2" />
    </svg>
  );
}
