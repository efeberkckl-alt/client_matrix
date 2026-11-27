/** Locale selection only. Never changes the identity seed, profile, or route. */
const regionLocale: Readonly<Record<string, readonly [string, string]>> = {
  US: ['en-US', 'America/New_York'], CA: ['en-CA', 'America/Toronto'], GB: ['en-GB', 'Europe/London'],
  AU: ['en-AU', 'Australia/Sydney'], NZ: ['en-NZ', 'Pacific/Auckland'], IE: ['en-IE', 'Europe/Dublin'],
  SG: ['en-SG', 'Asia/Singapore'], MY: ['ms-MY', 'Asia/Kuala_Lumpur'], VN: ['vi-VN', 'Asia/Ho_Chi_Minh'],
  TH: ['th-TH', 'Asia/Bangkok'], ID: ['id-ID', 'Asia/Jakarta'], PH: ['en-PH', 'Asia/Manila'],
  JP: ['ja-JP', 'Asia/Tokyo'], KR: ['ko-KR', 'Asia/Seoul'], IN: ['en-IN', 'Asia/Kolkata'],
  CN: ['zh-CN', 'Asia/Shanghai'], HK: ['zh-HK', 'Asia/Hong_Kong'], TW: ['zh-TW', 'Asia/Taipei'],
  MO: ['zh-MO', 'Asia/Macau'], DE: ['de-DE', 'Europe/Berlin'], FR: ['fr-FR', 'Europe/Paris'],
  IT: ['it-IT', 'Europe/Rome'], ES: ['es-ES', 'Europe/Madrid'], NL: ['nl-NL', 'Europe/Amsterdam'],
  PT: ['pt-PT', 'Europe/Lisbon'], PL: ['pl-PL', 'Europe/Warsaw'], SE: ['sv-SE', 'Europe/Stockholm'],
  BE: ['nl-BE', 'Europe/Brussels'], AT: ['de-AT', 'Europe/Vienna'], CH: ['de-CH', 'Europe/Zurich'],
  MX: ['es-MX', 'America/Mexico_City'], BR: ['pt-BR', 'America/Sao_Paulo'], AR: ['es-AR', 'America/Argentina/Buenos_Aires'],
  CO: ['es-CO', 'America/Bogota'], CL: ['es-CL', 'America/Santiago'], PE: ['es-PE', 'America/Lima'],
  AE: ['ar-AE', 'Asia/Dubai'], SA: ['ar-SA', 'Asia/Riyadh'], ZA: ['en-ZA', 'Africa/Johannesburg'],
  TR: ['tr-TR', 'Europe/Istanbul'], PK: ['en-PK', 'Asia/Karachi'], BD: ['bn-BD', 'Asia/Dhaka'],
};

export const fingerprintRegions = Object.keys(regionLocale).sort();
export interface ExitLocale { countryCode?: string; timezone?: string }
export interface FingerprintLocaleInput { region?: string; lang?: string; timezone?: string }
export type FingerprintLocalePatch = FingerprintLocaleInput & { mode: 'align' | 'manual' };

export function regionCode(value: unknown): string | undefined {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return Object.prototype.hasOwnProperty.call(regionLocale, code) ? code : undefined;
}

function readLang(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(value)) return;
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return; }
}

export function readTimezone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+)$/.test(value)) return;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } catch { return; }
}

export function validateFingerprintLocaleInput(value: unknown): FingerprintLocaleInput | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器语言与时区设置必须是对象');
  const input = value as FingerprintLocaleInput;
  const region = regionCode(input.region), lang = readLang(input.lang), timezone = readTimezone(input.timezone);
  if (input.region !== undefined && !region) throw new Error('浏览器地区无效');
  if (input.lang !== undefined && !lang) throw new Error('浏览器语言无效');
  if (input.timezone !== undefined && !timezone) throw new Error('浏览器时区无效');
  return { region, lang, timezone };
}

export function validateFingerprintLocalePatch(value: unknown): FingerprintLocalePatch | undefined {
  const input = validateFingerprintLocaleInput(value);
  if (!input) return;
  const { mode } = value as { mode?: unknown };
  if (mode !== 'align' && mode !== 'manual') throw new Error('浏览器语言与时区设置方式无效');
  if (mode === 'manual' && !input.lang && !input.timezone) throw new Error('请填写浏览器语言或时区');
  if (mode === 'manual' && input.region) throw new Error('手动模式不能指定地区');
  if (mode === 'align' && (input.lang || input.timezone)) throw new Error('对齐模式不能指定语言或时区');
  return { mode, ...input };
}

export function resolveFingerprintLocale(input?: FingerprintLocaleInput, observed?: ExitLocale, contentLang?: 'zh' | 'en') {
  const { region, lang, timezone } = validateFingerprintLocaleInput(input) ?? {};
  const observedRegion = regionCode(observed?.countryCode);
  const mapped = regionLocale[region || observedRegion || (contentLang === 'en' ? 'US' : 'CN')];
  return {
    lang: lang || mapped[0],
    timezone: timezone || (!region ? readTimezone(observed?.timezone) : undefined) || mapped[1],
  };
}
