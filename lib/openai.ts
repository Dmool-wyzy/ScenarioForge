import "server-only";
import OpenAI from "openai";
import { OpenAIProvider } from "@openai/agents";
import { Agent as HttpAgent, fetch as httpFetch } from "undici";
import { getResearchConfig } from "./env";

class ResearchModelProvider extends OpenAIProvider {
  constructor(private transport: HttpAgent, options: ConstructorParameters<typeof OpenAIProvider>[0]) {
    super(options);
  }

  override async close() {
    try { await super.close(); }
    finally { await this.transport.destroy(); }
  }
}

export function createModelProvider() {
  const env = getResearchConfig();
  const timeout = env.MODEL_TIMEOUT_SECONDS * 1000;
  // Native fetch otherwise stops connecting after 10 seconds, independently
  // of the SDK timeout. Keep this transport scoped to the research run.
  const transport = new HttpAgent({ connect: { timeout }, headersTimeout: timeout, bodyTimeout: timeout });
  return new ResearchModelProvider(transport, {
    openAIClient: new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, timeout, maxRetries: 0,
      fetch: httpFetch as unknown as typeof globalThis.fetch, fetchOptions: { dispatcher: transport } }),
    useResponses: env.OPENAI_API_MODE === "responses",
  });
}
