import { useCallback, useSyncExternalStore } from "react";
import { pickAttachmentFiles } from "@services/tauri";

type Draft = {
  selections: Record<string, number | undefined>;
  notes: Record<string, string>;
  attachments: string[];
  pendingAttachments: number;
  attachmentFailed: boolean;
  submitting: boolean;
  failed: boolean;
  submitted: boolean;
};

// Live request/message drafts survive navigation, but never an app restart.
// Weak keys release drafts when their source request/message is unreachable.
const drafts = new WeakMap<object, { snapshot: Draft; listeners: Set<() => void> }>();
function getDraft(key: object) {
  let store = drafts.get(key);
  if (!store) {
    store = {
      snapshot: {
        selections: {}, notes: {}, attachments: [], pendingAttachments: 0,
        attachmentFailed: false, submitting: false, failed: false, submitted: false,
      },
      listeners: new Set(),
    };
    drafts.set(key, store);
  }
  return store;
}

export function useUserInputDraft(draftKey: object) {
  const store = getDraft(draftKey);
  const draft = useSyncExternalStore(
    useCallback((listener: () => void) => {
      store.listeners.add(listener);
      return () => { store.listeners.delete(listener); };
    }, [store]),
    () => store.snapshot,
  );
  const update = useCallback((patch: Partial<Draft>) => {
    store.snapshot = { ...store.snapshot, ...patch };
    store.listeners.forEach((listener) => listener());
  }, [store]);
  const attach = useCallback((paths: string[]) => {
    if (store.snapshot.submitting || store.snapshot.submitted) return;
    update({ attachments: Array.from(new Set([...store.snapshot.attachments, ...paths])) });
  }, [store, update]);
  const readAttachments = useCallback(async (read: () => Promise<void>) => {
    if (store.snapshot.submitting || store.snapshot.submitted) return;
    update({ pendingAttachments: store.snapshot.pendingAttachments + 1, attachmentFailed: false });
    try {
      await read();
    } catch {
      update({ attachmentFailed: true });
    } finally {
      update({ pendingAttachments: store.snapshot.pendingAttachments - 1 });
    }
  }, [store, update]);
  const pickAttachments = useCallback(() => readAttachments(async () => {
    attach(await pickAttachmentFiles());
  }), [attach, readAttachments]);
  const removeAttachment = (path: string) => {
    if (store.snapshot.submitting || store.snapshot.submitted) return;
    update({ attachments: store.snapshot.attachments.filter((entry) => entry !== path) });
  };
  return { draft, store, update, attach, readAttachments, pickAttachments, removeAttachment };
}
