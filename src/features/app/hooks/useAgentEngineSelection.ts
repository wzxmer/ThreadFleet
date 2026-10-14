import { useEffect, useState } from "react";
import type { AgentEngine } from "@/types";

export function useAgentEngineSelection(defaultEngine: AgentEngine = "codex") {
  const [newAgentEngine, setNewAgentEngine] = useState<AgentEngine>(defaultEngine);
  const [geminiModel, setGeminiModel] = useState<string | null>(null);
  useEffect(() => setNewAgentEngine(defaultEngine), [defaultEngine]);
  return { newAgentEngine, setNewAgentEngine, geminiModel, setGeminiModel };
}
