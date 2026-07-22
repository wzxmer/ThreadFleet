import Archive from "lucide-react/dist/esm/icons/archive";
import Copy from "lucide-react/dist/esm/icons/copy";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Play from "lucide-react/dist/esm/icons/play";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import type { ManagedSession } from "@/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/features/i18n/I18nProvider";
import { PopoverMenuItem, PopoverSurface } from "@/features/design-system/components/popover/PopoverPrimitives";

type Props = {
  sessions: ManagedSession[];
  x: number;
  y: number;
  boundary: ContextMenuBoundary;
  busy: boolean;
  onClose: () => void;
  onResume: (session: ManagedSession) => void;
  onDerive: (sessions: ManagedSession[]) => void;
  onArchive: (sessions: ManagedSession[]) => void;
  onPermanentDelete: (sessions: ManagedSession[]) => void;
};

export type ContextMenuBoundary = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

const MENU_MARGIN = 8;
const PREFERRED_MENU_WIDTH = 220;

function resolveMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  boundary: ContextMenuBoundary,
) {
  const minX = boundary.left + MENU_MARGIN;
  const maxX = Math.max(minX, boundary.right - width - MENU_MARGIN);
  const minY = boundary.top + MENU_MARGIN;
  const maxY = Math.max(minY, boundary.bottom - height - MENU_MARGIN);
  const preferredX = x + width + MENU_MARGIN > boundary.right ? x - width : x;

  return {
    x: Math.max(minX, Math.min(preferredX, maxX)),
    y: Math.max(minY, Math.min(y, maxY)),
  };
}

export function SessionManagerContextMenu({ sessions, x, y, boundary, busy, onClose, onResume, onDerive, onArchive, onPermanentDelete }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const menuWidth = Math.min(
    PREFERRED_MENU_WIDTH,
    Math.max(0, boundary.right - boundary.left - MENU_MARGIN * 2),
  );
  const target = sessions[0];
  const active = sessions.filter((session) => !session.isArchived);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const closeOnViewportChange = () => onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", keydown);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    window.visualViewport?.addEventListener("scroll", closeOnViewportChange);
    window.visualViewport?.addEventListener("resize", closeOnViewportChange);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
      window.visualViewport?.removeEventListener("scroll", closeOnViewportChange);
      window.visualViewport?.removeEventListener("resize", closeOnViewportChange);
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const surface = ref.current;
    if (!surface) return;
    const next = resolveMenuPosition(
      x,
      y,
      surface.offsetWidth,
      surface.offsetHeight,
      boundary,
    );
    setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
  }, [boundary, sessions, x, y]);
  if (!target) return null;
  const run = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <PopoverSurface
      ref={ref}
      className="session-manager-context-menu"
      role="menu"
      style={{ left: position.x, top: position.y, width: menuWidth }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {sessions.length === 1 && (
        <>
          <PopoverMenuItem role="menuitem" disabled={busy} icon={<Play size={14} />} onClick={() => run(() => onResume(target))}>
            {t("sessionManager.continueSession")}
          </PopoverMenuItem>
        </>
      )}
      <PopoverMenuItem role="menuitem" disabled={busy} icon={<GitBranch size={14} />} onClick={() => run(() => onDerive(sessions))}>
        {sessions.length === 1 ? t("sessionManager.deriveToCurrentProject") : t("sessionManager.deriveSelectedToCurrentProject")}
      </PopoverMenuItem>
      {active.length > 0 && (
        <PopoverMenuItem role="menuitem" disabled={busy} icon={<Archive size={14} />} onClick={() => run(() => onArchive(active))}>
          {sessions.length === 1 ? t("sessionManager.archive") : t("sessionManager.archiveSelected")}
        </PopoverMenuItem>
      )}
      {active.length === 0 && <PopoverMenuItem role="menuitem" disabled={busy} className="is-danger" icon={<Trash2 size={14} />} onClick={() => run(() => onPermanentDelete(sessions))}>
          {sessions.length === 1 ? t("sessionManager.permanentDelete") : t("sessionManager.permanentDeleteSelected")}
      </PopoverMenuItem>}
      <PopoverMenuItem role="menuitem" icon={<Copy size={14} />} onClick={() => run(() => { void navigator.clipboard?.writeText(sessions.map((session) => session.threadId).join("\n")).catch(() => undefined); })}>
        {sessions.length === 1 ? t("sessionManager.copySessionId") : t("sessionManager.copySessionIds")}
      </PopoverMenuItem>
    </PopoverSurface>
  );
}
