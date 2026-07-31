import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import Link from "lucide-react/dist/esm/icons/link";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import { useI18n } from "../../i18n/I18nProvider";

type HomeActionsProps = {
  onStartNoProjectChat: () => void;
  onAddWorkspace: () => void;
  onAddWorkspaceFromUrl: () => void;
};

export function HomeActions({
  onStartNoProjectChat,
  onAddWorkspace,
  onAddWorkspaceFromUrl,
}: HomeActionsProps) {
  const { t } = useI18n();
  return (
    <div className="home-actions">
      <button
        className="home-button primary home-start-no-project-button"
        onClick={onStartNoProjectChat}
        data-tauri-drag-region="false"
      >
        <MessageSquarePlus className="home-icon" aria-hidden />
        {t("home.actions.noProjectChat")}
      </button>
      <button
        className="home-button secondary home-add-workspaces-button"
        onClick={onAddWorkspace}
        data-tauri-drag-region="false"
      >
        <FolderPlus className="home-icon" aria-hidden />
        {t("home.actions.addWorkspace")}
      </button>
      <button
        className="home-button secondary home-add-workspace-from-url-button"
        onClick={onAddWorkspaceFromUrl}
        data-tauri-drag-region="false"
      >
        <Link className="home-icon" aria-hidden />
        {t("home.actions.addWorkspaceFromUrl")}
      </button>
    </div>
  );
}
