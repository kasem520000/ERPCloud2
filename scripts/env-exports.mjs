#!/usr/bin/env node
/**
 * يُطبع محتوى `.env` على شكل أسطر `export KEY=$'…'` لتُقرأ في bash بـ:
 *
 *   eval "$(node scripts/env-exports.mjs)"
 *
 * **ولماذا لا قراءةٌ ساذجة لـ`KEY=VALUE` في السكربت؟** لأن `.env` الذي يولّده
 * `scripts/setup-env.mjs` يكتب مفاتيح PEM في سطرٍ واحد وبـ`\n` **حرفية**:
 *
 *   JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----\n"
 *
 * وقراءةٌ لا تُحوّل `\n` إلى أسطرٍ حقيقية تُمرّر مفتاحاً سطراً واحداً، فيفشل
 * `crypto.createPrivateKey` بـ`asn1 encoding routines::header too long` — ويبدو الخلل وكأنه
 * «فشل تسجيل دخول 500» لا خللَ قراءةِ إعدادات.
 *
 * فالمصدر واحد: مُحلِّل `scripts/dotenv.mjs` نفسه الذي يستعمله التطبيق (وفي `next.config.mjs`)
 * — لا نسخة ثانية من قواعد التحليل تفترق عنه.
 */
import { loadEnvFiles } from './dotenv.mjs';

// `loadEnvFiles` تُعبّئ `process.env` وتُرجع **أسماء الملفات** المحمَّلة، فالمفاتيح هي الفرق
// بين ما قبل الاستدعاء وما بعده (وهي بلا استثناءٍ القادمة من `.env*` لا من بيئة الأوامر).
const before = new Set(Object.keys(process.env));
loadEnvFiles(process.cwd());
const keys = Object.keys(process.env).filter((key) => !before.has(key));

for (const key of keys) {
  const value = process.env[key];
  // اقتباس ANSI-C (`$'…'`) يحمل الأسطر الجديدة والفواصل والرموز كما هي.
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  process.stdout.write(`export ${key}=$'${escaped}'\n`);
}
