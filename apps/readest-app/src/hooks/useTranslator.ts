import { useState, useCallback, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  ErrorCodes,
  getTranslator,
  getTranslators,
  isTranslatorAvailable,
  TranslatorName,
} from '@/services/translators';
import { getFromCache, storeInCache, UseTranslatorOptions } from '@/services/translators';
import { polish, preprocess } from '@/services/translators';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { useTranslation } from './useTranslation';

export function useTranslator({
  provider = 'deepl',
  sourceLang = 'AUTO',
  targetLang = 'EN',
  enablePolishing = true,
  enablePreprocessing = true,
}: UseTranslatorOptions = {}) {
  const _ = useTranslation();
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(provider);
  const [translator, setTransltor] = useState(() => getTranslator(provider));
  const [translators] = useState(() => getTranslators());

  useEffect(() => {
    setLoading(false);
  }, [provider, sourceLang, targetLang]);

  useEffect(() => {
    const availableTranslators = getTranslators().filter((t) => isTranslatorAvailable(t, !!token));
    const selectedTranslator =
      availableTranslators.find((t) => t.name === provider) || availableTranslators[0]!;
    const selectedProviderName = selectedTranslator.name as TranslatorName;
    setTransltor(getTranslator(selectedProviderName));
    setSelectedProvider(selectedProviderName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const translate = useCallback(
    async (
      input: string[],
      options?: { source?: string; target?: string; useCache?: boolean },
    ): Promise<string[]> => {
      const sourceLanguage = options?.source || sourceLang;
      const targetLanguage = options?.target || targetLang || getLocale();
      const useCache = options?.useCache ?? false;
      const textsToTranslate = enablePreprocessing ? preprocess(input) : input;

      if (textsToTranslate.length === 0 || textsToTranslate.every((t) => !t?.trim())) {
        return textsToTranslate;
      }

      const textsNeedingTranslation: string[] = [];
      const indicesNeedingTranslation: number[] = [];

      await Promise.all(
        textsToTranslate.map(async (text, index) => {
          if (!text?.trim()) return;

          const cachedTranslation = await getFromCache(
            text,
            sourceLanguage,
            targetLanguage,
            selectedProvider,
          );
          if (cachedTranslation) return;

          textsNeedingTranslation.push(text);
          indicesNeedingTranslation.push(index);
        }),
      );

      if (textsNeedingTranslation.length === 0) {
        const results = await Promise.all(
          textsToTranslate.map((text) =>
            getFromCache(text, sourceLanguage, targetLanguage, selectedProvider).then(
              (cached) => cached || text,
            ),
          ),
        );

        return enablePolishing ? polish(results, targetLanguage) : results;
      }

      setLoading(true);

      const runWithProvider = async (providerName: TranslatorName) => {
        const activeTranslator = translators.find((t) => t.name === providerName);
        if (!activeTranslator) {
          throw new Error(`No translator found for provider: ${providerName}`);
        }
        const translatedTexts = await activeTranslator.translate(
          textsNeedingTranslation,
          sourceLanguage,
          targetLanguage,
          token,
          useCache,
        );

        await Promise.all(
          textsNeedingTranslation.map(async (text, index) => {
            return storeInCache(
              text,
              translatedTexts[index] || '',
              sourceLanguage,
              targetLanguage,
              providerName,
            );
          }),
        );

        const results = [...textsToTranslate];
        indicesNeedingTranslation.forEach((originalIndex, translationIndex) => {
          results[originalIndex] = translatedTexts[translationIndex] || '';
        });

        await Promise.all(
          results.map(async (_, index) => {
            if (!indicesNeedingTranslation.includes(index)) {
              const originalText = textsToTranslate[index];
              if (!originalText?.trim()) return;

              const cachedTranslation = await getFromCache(
                originalText,
                sourceLanguage,
                targetLanguage,
                providerName,
              );

              if (cachedTranslation) {
                results[index] = cachedTranslation;
              }
            }
          }),
        );

        return results;
      };

      try {
        const results = await runWithProvider(selectedProvider);
        setLoading(false);
        return enablePolishing ? polish(results, targetLanguage) : results;
      } catch (err) {
        if (err instanceof Error && err.message.includes(ErrorCodes.DAILY_QUOTA_EXCEEDED)) {
          eventDispatcher.dispatch('toast', {
            timeout: 5000,
            message: _(
              'Daily translation quota reached. Upgrade your plan to continue using AI translations.',
            ),
            type: 'error',
          });
          setSelectedProvider('azure');
        }
        if (selectedProvider === 'groq' && err instanceof Error) {
          // Missing key, auth/rate-limit errors (Groq responds with a
          // non-OK status for both), or exhausted JSON-repair retries all
          // land here -- none of them will resolve by hammering Groq
          // again, so fall back to a provider that needs no key/quota at
          // all, and retry THIS call immediately rather than making the
          // user re-hit translate.
          const isKeyMissing = err.message.includes('Groq API key not set');
          const isRateLimited = /Groq translation failed \((?:401|403|429)/.test(err.message);
          const isMalformedAfterRetries = err.message.includes('Groq translation failed after');
          if (isKeyMissing || isRateLimited || isMalformedAfterRetries) {
            eventDispatcher.dispatch('toast', {
              timeout: 5000,
              message: isKeyMissing
                ? _('Groq API key not set. Falling back to Google Translate.')
                : isRateLimited
                  ? _('Groq translation unavailable (rate limit or auth). Falling back to Google Translate.')
                  : _('Groq returned an unusable response after retries. Falling back to Google Translate.'),
              type: 'error',
            });
            setSelectedProvider('google');
            try {
              const fallbackResults = await runWithProvider('google');
              setLoading(false);
              return enablePolishing ? polish(fallbackResults, targetLanguage) : fallbackResults;
            } catch (fallbackErr) {
              setLoading(false);
              throw fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
            }
          }
        }
        setLoading(false);
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedProvider, sourceLang, targetLang, translator, token],
  );

  return {
    translate,
    translator,
    translators,
    loading,
  };
}
