import type { TranscriptionConfig } from "./settings-manager.js";
const ENHANCEMENT_TIMEOUT_MS = 30_000;

/** Result from callEnhancementLLM — either the enhanced text or an error message. */
export type LLMCallResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Call an OpenAI-compatible chat completions API to enhance the transcript.
 * Returns the enhanced text on success, or an error message on failure.
 */
export async function callEnhancementLLM(
  prompt: string,
  config: TranscriptionConfig,
  apiKey: string,
  systemPrompt: string,
  requireComplete = false,
): Promise<LLMCallResult> {
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config.enhancementModel || "gpt-5-mini";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENHANCEMENT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: 512,
        reasoning_effort: "low",
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const errorMsg = `API error ${res.status}: ${body.slice(0, 300) || res.statusText}`;
      console.warn(`[transcription-enhancer] ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    if (requireComplete && json.choices?.[0]?.finish_reason !== "stop")
      return { ok: false, error: "Voice edit did not finish. Your comment has been kept; try a shorter edit." };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (json.usage) {
      const u = json.usage;
      const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
      console.log(
        `[transcription-enhancer] tokens: prompt=${u.prompt_tokens ?? "?"} completion=${u.completion_tokens ?? "?"} (reasoning=${reasoning})`,
      );
    }
    if (!text) return { ok: false, error: "Empty response from LLM" };
    return { ok: true, text };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("[transcription-enhancer] LLM call failed:", errorMsg);
    return { ok: false, error: errorMsg };
  } finally {
    clearTimeout(timeout);
  }
}
