import type { ModelPolicySettings } from "../model-policy";
import { resolveReasoningEffort } from "../model-policy";

export type WorkspaceModelStage = "prepare" | "generate" | "verify";

// These are ceilings, not output targets. Never retry a request to increase one.
// Leave room for reasoning only when the chosen policy can enable it.
export function workspaceModelOutputTokens(policy: ModelPolicySettings | undefined, stage: WorkspaceModelStage, inputCharacters = 0) {
  if (policy?.maxOutputTokens != null) return policy.maxOutputTokens;
  const reasoning = policy ? resolveReasoningEffort(policy) : undefined;
  const thinking = reasoning !== "none";
  if (stage !== "generate") return thinking ? 16384 : 8192;
  return thinking ? 32768 : inputCharacters > 32000 ? 24576 : 16384;
}
