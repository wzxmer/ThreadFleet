import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import MonitorUp from "lucide-react/dist/esm/icons/monitor-up";
import Plus from "lucide-react/dist/esm/icons/plus";
import X from "lucide-react/dist/esm/icons/x";
import type { TerminalTab } from "../hooks/useTerminalTabs";

type TerminalDockProps = {
  isOpen: boolean;
  terminals: TerminalTab[];
  activeTerminalId: string | null;
  onSelectTerminal: (terminalId: string) => void;
  onNewTerminal: () => void;
  onCloseTerminal: (terminalId: string) => void;
  onOpenExternalTerminal: () => void;
  onResizeStart?: (event: ReactMouseEvent) => void;
  terminalNode: ReactNode;
};

export function TerminalDock({
  isOpen,
  terminals,
  activeTerminalId,
  onSelectTerminal,
  onNewTerminal,
  onCloseTerminal,
  onOpenExternalTerminal,
  onResizeStart,
  terminalNode,
}: TerminalDockProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <section className="terminal-panel">
      {onResizeStart && (
        <div
          className="terminal-panel-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整终端面板大小"
          onMouseDown={onResizeStart}
        />
      )}
      <div className="terminal-header">
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {terminals.map((tab) => (
            <button
              key={tab.id}
              className={`terminal-tab${
                tab.id === activeTerminalId ? " active" : ""
              }`}
              data-button-elevation="none"
              type="button"
              role="tab"
              aria-selected={tab.id === activeTerminalId}
              onClick={() => onSelectTerminal(tab.id)}
            >
              <span className="terminal-tab-label">{tab.title}</span>
              <span
                className="terminal-tab-close"
                role="button"
                aria-label={`关闭 ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTerminal(tab.id);
                }}
              >
                <X aria-hidden />
              </span>
            </button>
          ))}
          <button
            className="terminal-tab-add"
            data-button-elevation="none"
            type="button"
            onClick={onNewTerminal}
            aria-label="新建终端"
            title="新建终端"
          >
            <Plus aria-hidden />
          </button>
        </div>
        <button
          className="terminal-external-button"
          data-button-elevation="none"
          type="button"
          onClick={onOpenExternalTerminal}
          aria-label="在系统终端打开"
          title="在系统终端打开"
        >
          <MonitorUp size={14} aria-hidden />
        </button>
      </div>
      <div className="terminal-body">{terminalNode}</div>
    </section>
  );
}
