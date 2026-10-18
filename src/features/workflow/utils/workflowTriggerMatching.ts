// Match complete ASCII names while allowing Chinese text around trigger phrases.
export function matchesWorkflowTrigger(task: string, trigger: string) {
  const phrase = trigger.trim().toLocaleLowerCase();
  if (!phrase) {
    return false;
  }
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = /^[a-z0-9_/$@]/i.test(phrase) ? "(?<![a-z0-9_-])" : "";
  const trailing = /[a-z0-9_-]$/i.test(phrase) ? "(?![a-z0-9_-])" : "";
  const pattern = new RegExp(`${leading}${escaped}${trailing}`, "gi");
  const normalizedTask = task.toLocaleLowerCase();
  for (const match of normalizedTask.matchAll(pattern)) {
    const clauses = normalizedTask.slice(0, match.index).split(/[，。；！？\n,;!?]/);
    const prefix = clauses[clauses.length - 1] ?? "";
    if (
      !/(?:不要|不用|无需|不需要|不必|别|do not|don't|without|never|stop)\s*(?:(?:使用|调用|启用|运行|触发|用|use|run|invoke|enable|trigger)\s*)?[$@]?$/u.test(
        prefix,
      )
    ) {
      return true;
    }
  }
  return false;
}
