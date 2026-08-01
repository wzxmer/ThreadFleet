/**
 * PROTOTYPE — throw away after particle-core direction selection.
 * One design, six task states. No production event wiring or persistence.
 */
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDot,
  Clock3,
  Code2,
  FileCode2,
  GitBranch,
  LayoutDashboard,
  Minus,
  PanelRight,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import "@fontsource-variable/noto-sans-sc";
import "./prototype.css";

type CoreState = "idle" | "thinking" | "executing" | "waiting" | "completed" | "failed";

type StateDefinition = {
  label: string;
  eyebrow: string;
  description: string;
  color: [number, number, number];
  icon: LucideIcon;
};

const STATE_ORDER: CoreState[] = ["idle", "thinking", "executing", "waiting", "completed", "failed"];

const STATE_DEFINITIONS: Record<CoreState, StateDefinition> = {
  idle: {
    label: "空闲",
    eyebrow: "READY",
    description: "内核凝聚，只有微弱呼吸。模型选择仍清晰。",
    color: [92, 218, 241],
    icon: CircleDot,
  },
  thinking: {
    label: "思考",
    eyebrow: "REASONING",
    description: "能量环稳定流动，中心保持凝聚；不使用上下跳动的频谱。",
    color: [87, 226, 255],
    icon: Sparkles,
  },
  executing: {
    label: "执行",
    eyebrow: "EXECUTING",
    description: "沿用同一核心结构，加快环流并加入短促向外脉冲；表达实际动作。",
    color: [70, 242, 220],
    icon: TerminalSquare,
  },
  waiting: {
    label: "等待",
    eyebrow: "INPUT REQUIRED",
    description: "粒子停在外围，节奏放慢并转为琥珀色；提示需要用户回应。",
    color: [255, 184, 85],
    icon: Clock3,
  },
  completed: {
    label: "完成",
    eyebrow: "COMPLETE",
    description: "粒子迅速归核，释放一次绿色脉冲，然后回到稳定状态。",
    color: [96, 235, 173],
    icon: Check,
  },
  failed: {
    label: "失败",
    eyebrow: "ATTENTION",
    description: "内核短暂失稳并闪烁一次，随后停止；不持续报警。",
    color: [255, 100, 124],
    icon: CircleAlert,
  },
};

const threadRows = [
  { label: "粒子核心状态设计", meta: "正在思考 · 12 秒", tone: "active" },
  { label: "审查安装迁移逻辑", meta: "等待输入 · 3 小时", tone: "waiting" },
  { label: "同步 App Server 事件", meta: "完成 · 4 小时", tone: "done" },
  { label: "整理 UI 样式基线", meta: "完成 · 5 小时", tone: "done" },
];

function ParticleCore({
  state,
  size,
  reducedMotion,
  className = "",
}: {
  state: CoreState;
  size: number;
  reducedMotion: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`particle-core flow-core is-${state} ${reducedMotion ? "is-reduced-motion" : ""} ${className}`}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <circle className="flow-core-aura" cx="50" cy="50" r="41" />
      <g className="flow-core-orbit flow-core-orbit-primary">
        <circle className="flow-core-ring flow-core-ring-track" cx="50" cy="50" r="29" />
        <circle className="flow-core-ring flow-core-ring-sweep" cx="50" cy="50" r="29" />
      </g>
      <g className="flow-core-orbit flow-core-orbit-secondary">
        <circle className="flow-core-ring flow-core-ring-track secondary" cx="50" cy="50" r="37" />
        <circle className="flow-core-ring flow-core-ring-sweep secondary" cx="50" cy="50" r="37" />
      </g>
      <circle className="flow-core-ripple flow-core-ripple-one" cx="50" cy="50" r="18" />
      <circle className="flow-core-ripple flow-core-ripple-two" cx="50" cy="50" r="18" />
      <circle className="flow-core-halo" cx="50" cy="50" r="18" />
      <circle className="flow-core-center" cx="50" cy="50" r="10" />
      <circle className="flow-core-highlight" cx="46.5" cy="46" r="3.5" />
    </svg>
  );
}

function WindowControls() {
  return (
    <div className="core-window-controls" aria-label="窗口控制">
      <button type="button" aria-label="最小化"><Minus /></button>
      <button type="button" aria-label="最大化"><Square /></button>
      <button type="button" aria-label="关闭">×</button>
    </div>
  );
}

function ParticleCorePrototype() {
  const [coreState, setCoreState] = useState<CoreState>("thinking");
  const [autoDemo, setAutoDemo] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const definition = STATE_DEFINITIONS[coreState];
  const StateIcon = definition.icon;

  useEffect(() => {
    if (!autoDemo) return;
    const sequence: CoreState[] = ["idle", "thinking", "executing", "waiting", "completed"];
    let index = Math.max(0, sequence.indexOf(coreState));
    const timer = window.setInterval(() => {
      index = (index + 1) % sequence.length;
      setCoreState(sequence[index]);
    }, 3200);
    return () => window.clearInterval(timer);
  }, [autoDemo, coreState]);

  const stateIndex = useMemo(() => STATE_ORDER.indexOf(coreState) + 1, [coreState]);

  const chooseState = (nextState: CoreState) => {
    setAutoDemo(false);
    setCoreState(nextState);
  };

  return (
    <main className={`core-lab state-${coreState}`}>
      <div className="core-grid-field" />
      <header className="core-titlebar">
        <div className="core-brand"><span>CM</span><div><b>CODEX MONITOR</b><small>PARTICLE CORE / PROTOTYPE 01</small></div></div>
        <div className="core-link-state"><i /> LOCAL LINK STABLE</div>
        <WindowControls />
      </header>

      <aside className="core-sidebar">
        <div className="core-sidebar-head"><button type="button"><LayoutDashboard /></button><b>任务链路</b><button type="button"><Plus /></button></div>
        <label className="core-search"><Search /><input placeholder="搜索会话" /></label>
        <div className="core-workspace"><span>CM</span><div><b>CodexMonitor</b><small>main · D:\Project</small></div><ChevronDown /></div>
        <div className="core-thread-list">
          {threadRows.map((thread, index) => (
            <button className={index === 0 ? "active" : ""} type="button" key={thread.label}>
              <i className={`tone-${thread.tone}`} />
              <span><b>{thread.label}</b><small>{thread.meta}</small></span>
              {index === 0 ? <em><u /><u /><u /></em> : null}
            </button>
          ))}
        </div>
        <div className="core-sidebar-tools"><button type="button"><Code2 /> 代码</button><button type="button"><GitBranch /> Git</button><button type="button"><Settings /> 设置</button></div>
      </aside>

      <section className="core-workbench">
        <div className="core-workbench-head">
          <div><span>ACTIVE THREAD / 46</span><h1>粒子核心状态设计</h1></div>
          <div><button type="button"><GitBranch /> main</button><button type="button"><PanelRight /></button></div>
        </div>

        <div className="core-conversation">
          <article className="core-message user-message">
            <div className="core-avatar">浮</div>
            <div><header><b>浮生</b><time>21:43</time></header><p>用类似液态光球的效果替代大模型图标。思考和执行时动起来。</p></div>
          </article>
          <article className="core-message agent-message">
            <div className="core-avatar"><Bot /></div>
            <div><header><b>BT-7274</b><span className="live-state"><i /> {definition.label}中</span></header><p>状态信号已连接到粒子核心预览。当前展示：{definition.description}</p>
              <div className="core-tool-row"><TerminalSquare /><span><b>原型渲染</b><small>SVG / CSS composite animation</small></span><em><Check /> 活动</em></div>
            </div>
          </article>
        </div>

        <div className="core-composer">
          <div className="core-input-placeholder">继续下达任务…</div>
          <div className="core-composer-bar">
            <button className={`core-model-selector is-${coreState}`} type="button" title={`模型 · 当前${definition.label}`}>
              <span className="core-model-visual"><ParticleCore state={coreState} size={28} reducedMotion={reducedMotion} /></span>
              <span className="core-model-copy"><b>GPT-5.4</b><small>{definition.label}</small></span>
              <ChevronDown />
            </button>
            <button className="core-effort" type="button">中等推理 <ChevronDown /></button>
            <span className="grow" />
            <button className="core-send" type="button" aria-label={coreState === "idle" ? "发送" : "停止"}>
              {coreState === "idle" || coreState === "completed" || coreState === "failed" ? <Send /> : <Square />}
            </button>
          </div>
        </div>
      </section>

      <aside className="core-inspector">
        <div className="core-inspector-head"><div><span>动态细节</span><b>8× 放大诊断</b></div><StateIcon /></div>
        <section className="core-stage">
          <div className="core-stage-orbit one" /><div className="core-stage-orbit two" />
          <ParticleCore state={coreState} size={190} reducedMotion={reducedMotion} className="large-core" />
          <div className="core-stage-label"><span>{definition.eyebrow}</span><b>{definition.label}</b></div>
        </section>

        <section className="core-state-copy">
          <div><span>状态 {String(stateIndex).padStart(2, "0")} / 06</span><i /></div>
          <h2>{definition.label}</h2>
          <p>{definition.description}</p>
        </section>

        <section className="core-state-controls">
          <span>状态预览</span>
          <div>
            {STATE_ORDER.map((state) => {
              const item = STATE_DEFINITIONS[state];
              const Icon = item.icon;
              return <button className={state === coreState ? "active" : ""} type="button" key={state} onClick={() => chooseState(state)}><Icon /><span>{item.label}</span></button>;
            })}
          </div>
        </section>

        <section className="core-playback-controls">
          <button type="button" className={autoDemo ? "active" : ""} onClick={() => setAutoDemo((value) => !value)}>
            {autoDemo ? <Pause /> : <Play />}<span>{autoDemo ? "暂停演示" : "自动演示"}</span>
          </button>
          <label><span><b>减少动态</b><small>仅保留颜色与光强反馈</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /><i /></label>
        </section>

        <footer><FileCode2 /><span>单一设计 · 状态驱动 · 未接生产</span></footer>
      </aside>
    </main>
  );
}

type PrototypeWindow = Window & {
  __jarvisPrototypeRoot?: ReturnType<typeof ReactDOM.createRoot>;
};

const prototypeWindow = window as PrototypeWindow;
const prototypeRoot = prototypeWindow.__jarvisPrototypeRoot
  ?? ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
prototypeWindow.__jarvisPrototypeRoot = prototypeRoot;
prototypeRoot.render(<React.StrictMode><ParticleCorePrototype /></React.StrictMode>);
