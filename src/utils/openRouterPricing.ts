import type { Locale } from "../i18n";

type OpenRouterPricing = {
  prompt?: string;
  completion?: string;
};

function formatPricePerMillion(value: string | undefined, locale: Locale) {
  if (value === undefined) return null;
  const perMillion = Number(value) * 1_000_000;
  if (!Number.isFinite(perMillion) || perMillion < 0) return null;
  if (perMillion > 0 && perMillion < 0.000001) return "<$0.000001/M";
  const amount = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6
  }).format(perMillion);
  return `$${amount}/M`;
}

export function formatOpenRouterPricing(
  pricing: OpenRouterPricing | undefined,
  locale: Locale,
  labels: { input: string; output: string; unavailable: string }
) {
  const prompt = formatPricePerMillion(pricing?.prompt, locale);
  const completion = formatPricePerMillion(pricing?.completion, locale);
  if (!prompt || !completion) return labels.unavailable;
  return `${prompt} ${labels.input} · ${completion} ${labels.output}`;
}

export { formatPricePerMillion };
