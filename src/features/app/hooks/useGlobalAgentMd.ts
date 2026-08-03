import { useEffect, useState } from "react";
import { readGlobalAgentsMd } from "@services/tauri";

export function useGlobalAgentMd() {
  const [content, setContent] = useState("");

  useEffect(() => {
    let cancelled = false;

    void readGlobalAgentsMd()
      .then((response) => {
        if (!cancelled) {
          setContent(response.content);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return content;
}
