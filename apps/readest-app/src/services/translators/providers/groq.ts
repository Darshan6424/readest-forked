import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { stubTranslation as _ } from '@/utils/misc';
import { TranslationProvider } from '../types';
import { normalizeToShortLang } from '@/utils/lang';
import { isTauriAppPlatform } from '@/services/environment';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_GROQ_SETTINGS } from '@/services/constants';

const GROQ_API_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// How many times to ask the model to fix its own output before giving up.
// Each retry costs one more request against the free-tier rate limit, so
// keep this small -- malformed JSON from a 70B instruct model at temp=0.2
// is rare; this is a safety net, not the expected path.
const MAX_JSON_RETRIES = 3;

const doFetch = isTauriAppPlatform() ? tauriFetch : fetch;

export const getGroqSettings = () => {
  return useSettingsStore.getState().settings?.groq ?? DEFAULT_GROQ_SETTINGS;
};

const langName = (code: string): string => {
  // Groq/the LLM understands plain language names far more reliably than
  // ISO codes (especially region variants like ZH-HANT), so normalize down
  // to the short code and let the prompt spell out what it means loosely.
  const short = normalizeToShortLang(code).toUpperCase();
  return short === 'AUTO' ? 'the source language (auto-detect it)' : short;
};

const buildSystemPrompt = (sourceLabel: string, targetLabel: string) =>
  `You are a professional literary translator. Translate each string in the ` +
  `provided JSON array from ${sourceLabel} to ${targetLabel}. ` +
  `Respond with ONLY a JSON object of the shape {"texts": ["...", "..."]} -- ` +
  `the array MUST have exactly the same length and order as the input array, ` +
  `containing just the translated strings, no commentary, no markdown code ` +
  `fences, no explanations. Preserve line breaks within a string. If a ` +
  `string is empty or has no translatable text, return it unchanged.`;

/**
 * Extracts a same-length string array from a Groq chat-completion response,
 * tolerating the model wrapping the array under an arbitrary key or
 * (rarely, despite response_format) returning a bare array.
 */
const extractArray = (content: string, expectedLength: number): string[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const candidate: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown> | null)?.['texts'] ??
      (parsed && typeof parsed === 'object' ? Object.values(parsed as object)[0] : null);

  if (!Array.isArray(candidate) || candidate.length !== expectedLength) {
    return null;
  }
  if (!candidate.every((item) => typeof item === 'string')) {
    return null;
  }
  return candidate as string[];
};

export const groqProvider: TranslationProvider = {
  name: 'groq',
  label: _('Groq (AI)'),
  // Not gated by Readest's own auth/quota system -- this calls Groq directly
  // with the user's own key, so no Readest login token is required.
  authRequired: false,
  translate: async (
    texts: string[],
    sourceLang: string,
    targetLang: string,
    _token?: string | null,
    _useCache: boolean = false,
    signal?: AbortSignal,
  ): Promise<string[]> => {
    if (!texts.length) return [];

    const { apiKey, model } = getGroqSettings();
    if (!apiKey) {
      throw new Error(
        'Groq API key not set. Add one in Settings -> Language -> Translation Service before using the Groq translator.',
      );
    }

    const sourceLabel = langName(sourceLang);
    const targetLabel = langName(targetLang);
    const systemPrompt = buildSystemPrompt(sourceLabel, targetLabel);

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ texts }) },
    ];

    let lastError = 'unknown error';

    for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
      const response = await doFetch(GROQ_API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal,
        body: JSON.stringify({
          model: model || DEFAULT_GROQ_SETTINGS.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages,
        }),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Groq translation failed (${response.status}): ${errBody.slice(0, 200)}`);
      }

      const data = await response.json();
      const content: string | undefined = data?.choices?.[0]?.message?.content;

      if (!content) {
        lastError = 'empty response from model';
      } else {
        const result = extractArray(content, texts.length);
        if (result) {
          return result.map((t, i) => (t.length ? t : texts[i]!));
        }
        lastError = `expected a JSON object like {"texts": [...${texts.length} strings]}, got: ${content.slice(0, 300)}`;
      }

      if (attempt < MAX_JSON_RETRIES) {
        messages.push({ role: 'assistant', content: content ?? '' });
        messages.push({
          role: 'user',
          content:
            `That response was invalid: ${lastError}. ` +
            `Reply again with ONLY valid JSON of the exact shape ` +
            `{"texts": [${texts.length} translated strings, same order as before]}. ` +
            `No other text.`,
        });
      }
    }

    throw new Error(`Groq translation failed after ${MAX_JSON_RETRIES + 1} attempts: ${lastError}`);
  },
};
