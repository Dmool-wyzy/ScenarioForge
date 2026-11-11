import "server-only";
import OpenAI from "openai";
import { AsyncLocalStorage } from "node:async_hooks";
import { OpenAIProvider, type Model } from "@openai/agents";
import { Agent as HttpAgent, fetch as httpFetch } from "undici";
import { getResearchConfig } from "./env";
import { modelFetch, modelTransport } from "./model-endpoint";
import { modelResponseFetch } from "./model-response";
import type { ResearchConfig } from "./model-settings";
import { assertStructuredOutputSupported } from "./model-capabilities";
import type { ModelDiagnostic, ModelDiagnosticOptions } from "./model-diagnostics";

type DiagnosticScope = AsyncLocalStorage<{ last?: ModelDiagnostic }>;

class ResearchModelProvider extends OpenAIProvider {
  constructor(private transport: HttpAgent, private protocol: { baseUrl: string; apiMode: ResearchConfig["OPENAI_API_MODE"] }, private diagnostics: DiagnosticScope, private diagnosticOptions: ModelDiagnosticOptions, options: ConstructorParameters<typeof OpenAIProvider>[0]) {
    super(options);
  }

  override async getModel(modelName?: string): Promise<Model> {
    const model = await super.getModel(modelName);
    const check = (request: Parameters<Model["getResponse"]>[0]) => {
      if (request.outputType !== "text") assertStructuredOutputSupported(this.protocol);
    };
    return {
      supportsPromptModelSelection: model.supportsPromptModelSelection,
      getResponse: request => this.diagnostics.run({}, async () => {
        check(request);
        try { return await model.getResponse(request); }
        catch (error) {
          const last = this.diagnostics.getStore()?.last;
          // The SDK's own deadline aborts fetch with a generic AbortError.
          // Its final error class distinguishes that deadline from a caller's
          // cancellation without guessing from elapsed time or error strings.
          if (error instanceof OpenAI.APIConnectionTimeoutError && last?.phase === "failed" && last.failureKind === "aborted" && !request.signal?.aborted) {
            try { await this.diagnosticOptions.onDiagnostic?.({ ...last, failureKind: "timeout" }); }
            catch { /* Preserve the primary timeout if diagnostic recording fails. */ }
          }
          request.signal?.throwIfAborted();
          throw error;
        }
      }),
      async *getStreamedResponse(request) { check(request); yield* model.getStreamedResponse(request); },
      ...(model.getRetryAdvice ? { getRetryAdvice: model.getRetryAdvice.bind(model) } : {}),
    };
  }

  override async close() {
    try { await super.close(); }
    finally { await this.transport.destroy(); }
  }
}

export function createModelProvider(env: ResearchConfig = getResearchConfig(), options: ModelDiagnosticOptions = {}) {
  const timeout = env.MODEL_TIMEOUT_SECONDS * 1000;
  // Native fetch otherwise stops connecting after 10 seconds, independently
  // of the SDK timeout. Keep this transport scoped to the research run.
  const transport = modelTransport(env.OPENAI_BASE_URL, timeout, env.PROJECT_MODEL_CONFIG ? env.MODEL_VALIDATED_ADDRESS : undefined);
  const diagnostics: DiagnosticScope = new AsyncLocalStorage();
  const diagnosticOptions: ModelDiagnosticOptions = { onDiagnostic: async diagnostic => {
    const scope = diagnostics.getStore();
    if (scope) scope.last = diagnostic;
    await options.onDiagnostic?.(diagnostic);
  } };
  return new ResearchModelProvider(transport, { baseUrl: env.OPENAI_BASE_URL, apiMode: env.OPENAI_API_MODE }, diagnostics, diagnosticOptions, {
    openAIClient: new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL, timeout, maxRetries: 0,
      fetch: modelResponseFetch(env.PROJECT_MODEL_CONFIG ? modelFetch(transport, env.OPENAI_BASE_URL, { preserveStreamingResponse: true, deferResponseBody: true }) : httpFetch as unknown as typeof globalThis.fetch, env.OPENAI_API_MODE, diagnosticOptions), fetchOptions: { dispatcher: transport } }),
    useResponses: env.OPENAI_API_MODE === "responses",
    strictFeatureValidation: true,
  });
}
