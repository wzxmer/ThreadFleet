import { useCallback, useMemo } from "react";
import type { AutocompleteItem } from "./useComposerAutocomplete";
import {
  createAutocompleteSearchParts,
  useComposerAutocomplete,
} from "./useComposerAutocomplete";
import type {
  AppOption,
  ComposerTriggerMode,
  CustomPromptOption,
} from "../../../types";
import { connectorMentionSlug } from "../../apps/utils/appMentions";
import {
  buildPromptInsertText,
  findNextPromptArgCursor,
  findPromptArgRangeAtCursor,
  getPromptArgumentHint,
} from "../../../utils/customPrompts";
import { isComposingEvent } from "../../../utils/keys";

type Skill = { name: string; description?: string };
type UseComposerAutocompleteStateArgs = {
  agentEngine?: "codex" | "gemini";
  text: string;
  selectionStart: number | null;
  disabled: boolean;
  appsEnabled: boolean;
  skills: Skill[];
  apps: AppOption[];
  prompts: CustomPromptOption[];
  files: string[];
  composerTriggerMode?: ComposerTriggerMode;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setText: (next: string) => void;
  setSelectionStart: (next: number | null) => void;
  onItemApplied?: (
    item: AutocompleteItem,
    context: { triggerChar: string; insertedText: string },
  ) => void;
};

const MAX_FILE_SUGGESTIONS = 500;
const FILE_TRIGGER_PREFIX = new RegExp("^(?:\\s|[\"'`]|\\(|\\[|\\{)$");

function getFileTriggerQuery(
  text: string,
  cursor: number | null,
  triggerChar: string,
) {
  if (!text || cursor === null) {
    return null;
  }
  const beforeCursor = text.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf(triggerChar);
  if (atIndex < 0) {
    return null;
  }
  const prevChar = atIndex > 0 ? beforeCursor[atIndex - 1] : "";
  if (prevChar && !FILE_TRIGGER_PREFIX.test(prevChar)) {
    return null;
  }
  const afterAt = beforeCursor.slice(atIndex + 1);
  if (/\s/.test(afterAt)) {
    return null;
  }
  return afterAt;
}

export function useComposerAutocompleteState({
  agentEngine = "codex",
  text,
  selectionStart,
  disabled,
  appsEnabled,
  skills,
  apps,
  prompts,
  files,
  composerTriggerMode = "default",
  textareaRef,
  setText,
  setSelectionStart,
  onItemApplied,
}: UseComposerAutocompleteStateArgs) {
  const skillItems = useMemo<AutocompleteItem[]>(
    () => [
      ...skills.map((skill) => ({
        id: `skill:${skill.name}`,
        label: skill.name,
        description: skill.description,
        insertText: skill.name,
        group: "Skills" as const,
      })),
      ...apps
        .filter((app) => app.isAccessible)
        .map((app) => ({
          id: `app:${app.id}`,
          label: app.name,
          description: app.description,
          insertText: connectorMentionSlug(app.name),
          group: "Apps" as const,
          mentionPath: `app://${app.id}`,
        })),
    ],
    [apps, skills],
  );

  const slashTriggerChar = composerTriggerMode === "swap-slash-at" ? "@" : "/";
  const fileTriggerChar = composerTriggerMode === "swap-slash-at" ? "/" : "@";
  const fileTriggerQuery = useMemo(
    () => getFileTriggerQuery(text, selectionStart, fileTriggerChar),
    [fileTriggerChar, selectionStart, text],
  );
  const fileTriggerActive = fileTriggerQuery !== null;
  const hasFileTriggerQuery = Boolean(fileTriggerQuery);
  const fileItems = useMemo<AutocompleteItem[]>(
    () =>
      fileTriggerActive
        ? (() => {
            const limited = hasFileTriggerQuery
              ? files
              : files.slice(0, MAX_FILE_SUGGESTIONS);
            return limited.map((path) => ({
              id: path,
              label: path,
              insertText: path,
              group: "Files" as const,
              searchParts: createAutocompleteSearchParts(path),
            }));
          })()
        : [],
    [fileTriggerActive, files, hasFileTriggerQuery],
  );

  const promptItems = useMemo<AutocompleteItem[]>(
    () =>
      prompts
        .filter((prompt) => prompt.name)
        .map((prompt) => {
          const insert = buildPromptInsertText(prompt);
          return {
            id: `prompt:${prompt.name}`,
            label: `prompts:${prompt.name}`,
            description: prompt.description,
            hint: getPromptArgumentHint(prompt),
            insertText: insert.text,
            cursorOffset: insert.cursorOffset,
            group: "Prompts" as const,
          };
        }),
    [prompts],
  );

  const slashCommandItems = useMemo<AutocompleteItem[]>(() => {
    const commands: AutocompleteItem[] = [
      {
        id: "compact",
        label: "compact",
        description: "compact the active thread context",
        insertText: "compact",
        group: "Slash",
      },
      {
        id: "fast",
        label: "fast",
        description: "toggle Fast mode for upcoming turns",
        insertText: "fast",
        group: "Slash",
      },
      {
        id: "fork",
        label: "fork",
        description: "branch into a new thread",
        insertText: "fork",
        group: "Slash",
      },
      {
        id: "mcp",
        label: "mcp",
        description: "list configured MCP tools",
        insertText: "mcp",
        group: "Slash",
      },
      {
        id: "new",
        label: "new",
        description: "start a new chat",
        insertText: "new",
        group: "Slash",
      },
      {
        id: "review",
        label: "review",
        description: "start a code review",
        insertText: "review",
        group: "Slash",
      },
      {
        id: "resume",
        label: "resume",
        description: "refresh the active thread",
        insertText: "resume",
        group: "Slash",
      },
      {
        id: "status",
        label: "status",
        description: "show session status",
        insertText: "status",
        group: "Slash",
      },
    ];
    if (appsEnabled) {
      commands.push({
        id: "apps",
        label: "apps",
        description: "list available apps",
        insertText: "apps",
        group: "Slash",
      });
    }
    return commands.filter((command) => agentEngine === "codex" || command.id === "new")
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [appsEnabled, agentEngine]);

  const slashItems = useMemo<AutocompleteItem[]>(
    () => [...slashCommandItems, ...promptItems],
    [promptItems, slashCommandItems],
  );

  const triggers = useMemo(
    () => [
      { trigger: slashTriggerChar, items: slashItems },
      { trigger: "$", items: skillItems },
      { trigger: fileTriggerChar, items: fileItems },
    ],
    [fileItems, fileTriggerChar, skillItems, slashItems, slashTriggerChar],
  );

  const {
    active: isAutocompleteOpen,
    matches: autocompleteMatches,
    highlightIndex,
    setHighlightIndex,
    moveHighlight,
    range: autocompleteRange,
    trigger: autocompleteTrigger,
    query: autocompleteQuery,
    close: closeAutocomplete,
  } = useComposerAutocomplete({
    text,
    selectionStart,
    triggers,
  });
  const autocompleteAnchorIndex = autocompleteRange
    ? Math.max(0, autocompleteRange.start - 1)
    : null;

  const applyAutocomplete = useCallback(
    (item: AutocompleteItem) => {
      if (!autocompleteRange) {
        return;
      }
      const triggerIndex = Math.max(0, autocompleteRange.start - 1);
      const triggerChar = text[triggerIndex] ?? "";
      const isFileCompletion = item.group === "Files";
      const cursor = selectionStart ?? autocompleteRange.end;
      const promptRange =
        isFileCompletion ? findPromptArgRangeAtCursor(text, cursor) : null;
      const before =
        isFileCompletion
          ? text.slice(0, triggerIndex)
          : text.slice(0, autocompleteRange.start);
      const after = text.slice(autocompleteRange.end);
      const insert = item.insertText ?? item.label;
      const actualInsert = isFileCompletion
        ? insert.replace(/^@+/, "")
        : insert;
      const needsSpace = promptRange
        ? false
        : after.length === 0
          ? true
          : !/^\s/.test(after);
      const nextText = `${before}${actualInsert}${needsSpace ? " " : ""}${after}`;
      setText(nextText);
      onItemApplied?.(item, { triggerChar, insertedText: actualInsert });
      closeAutocomplete();
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        const insertCursor = Math.min(
          actualInsert.length,
          Math.max(0, item.cursorOffset ?? actualInsert.length),
        );
        const cursor =
          before.length +
          insertCursor +
          (item.cursorOffset === undefined ? (needsSpace ? 1 : 0) : 0);
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
        setSelectionStart(cursor);
      });
    },
    [
      autocompleteRange,
      closeAutocomplete,
      selectionStart,
      setSelectionStart,
      setText,
      text,
      textareaRef,
      onItemApplied,
    ],
  );

  const handleTextChange = useCallback(
    (next: string, cursor: number | null) => {
      setText(next);
      setSelectionStart(cursor);
    },
    [setSelectionStart, setText],
  );

  const handleSelectionChange = useCallback(
    (cursor: number | null) => {
      setSelectionStart(cursor);
    },
    [setSelectionStart],
  );

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }
      if (isComposingEvent(event)) {
        return;
      }
      if (isAutocompleteOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveHighlight(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveHighlight(-1);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          const selected =
            autocompleteMatches[highlightIndex] ?? autocompleteMatches[0];
          if (
            autocompleteTrigger === slashTriggerChar &&
            selected?.group === "Prompts" &&
            !autocompleteQuery.toLowerCase().startsWith("prompts:")
          ) {
            closeAutocomplete();
            return;
          }
          event.preventDefault();
          if (selected) {
            applyAutocomplete(selected);
          }
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          const selected =
            autocompleteMatches[highlightIndex] ?? autocompleteMatches[0];
          if (selected) {
            applyAutocomplete(selected);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeAutocomplete();
          return;
        }
      }
      if (event.key === "Tab") {
        const cursor = selectionStart ?? text.length;
        const nextCursor = findNextPromptArgCursor(text, cursor);
        if (nextCursor !== null) {
          event.preventDefault();
          requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea) {
              return;
            }
            textarea.focus();
            textarea.setSelectionRange(nextCursor, nextCursor);
            setSelectionStart(nextCursor);
          });
        }
      }
    },
    [
      applyAutocomplete,
      autocompleteMatches,
      autocompleteQuery,
      autocompleteTrigger,
      closeAutocomplete,
      disabled,
      highlightIndex,
      isAutocompleteOpen,
      moveHighlight,
      selectionStart,
      setSelectionStart,
      slashTriggerChar,
      text,
      textareaRef,
    ],
  );

  return {
    isAutocompleteOpen,
    autocompleteMatches,
    autocompleteAnchorIndex,
    highlightIndex,
    setHighlightIndex,
    applyAutocomplete,
    handleInputKeyDown,
    handleTextChange,
    handleSelectionChange,
    fileTriggerActive,
  };
}
