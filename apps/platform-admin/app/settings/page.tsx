'use client';

import { useEffect, useState } from 'react';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { ApiError, apiData, apiPut } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

/**
 * إعدادات المنصة — the screen P-C1 adds so that nothing is configured by editing `.env`
 * on the host any more (`PLATFORM_CONSOLE_PLAN.md` §1).
 *
 * Every field is rendered from the **catalogue the API validates with**
 * (`platformSettingDefinitions` in `@erp/contracts`): labels, help text, kind and default
 * all arrive from `GET /platform/settings`, so a key cannot exist on one side only and the
 * screen never invents a field the API would reject.
 *
 * The form is read-only for an operator without `console.settings.manage` — the API would
 * answer 403 anyway; disabling the inputs says so before the click.
 *
 * P-C4 added six `billing.*` keys to the same catalogue — the seller identity, the VAT rate,
 * the payment terms and the collection ladder that the tax invoice and the dunning board are
 * built from. They appear here with no change to this file: the screen renders the catalogue,
 * so a key added on the contract side is a field on the screen the moment the API serves it.
 */

type SettingKind = 'string' | 'email' | 'string-list' | 'integer' | 'boolean' | 'select';

type SettingView = {
  key: string;
  labelAr: string;
  labelEn: string;
  kind: SettingKind;
  helpAr: string;
  value: string | string[] | number | boolean;
  /** خيارات المفتاح إن كان قائمة — تصل من الكتالوج، فلا تُخترع هنا. */
  options?: string[];
  /** تسميات الخيارات بالعربية (موازية لـ`options`) — `0` تصير «الأحد». */
  optionLabels?: string[];
  min?: number;
  max?: number;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

type SettingsResponse = {
  settings: SettingView[];
  environment: { name: string; labelAr: string };
};

/** The wire value → what the input shows. Lists are one entry per line. */
function toDraft(setting: SettingView): string {
  if (setting.kind === 'string-list') return (setting.value as string[]).join('\n');
  if (setting.kind === 'boolean') return setting.value === true ? 'on' : 'off';
  return String(setting.value ?? '');
}

/** …and back. `boolean` and `integer` are typed, not stringified, because the API checks types. */
function fromDraft(setting: SettingView, draft: string): unknown {
  switch (setting.kind) {
    case 'string-list':
      return draft
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    case 'boolean':
      return draft === 'on';
    case 'integer':
      return Number(draft);
    default:
      return draft;
  }
}

export default function PlatformSettingsPage() {
  const { canConsole } = useSession();
  const canWrite = canConsole('console.settings.manage');
  const settings = useQuery<SettingsResponse>(() => apiData<SettingsResponse>('/platform/settings'), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setDrafts(
      Object.fromEntries(settings.data.settings.map((setting) => [setting.key, toDraft(setting)])),
    );
  }, [settings.data]);

  async function save() {
    if (!settings.data) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const values = Object.fromEntries(
        settings.data.settings.map((setting) => [setting.key, fromDraft(setting, drafts[setting.key] ?? '')]),
      );
      await apiPut('/platform/settings', { values });
      setMessage({ kind: 'ok', text: 'حُفظت إعدادات المنصة، وسُجِّل التغيير في التدقيق.' });
      settings.reload();
    } catch (error) {
      setMessage({
        kind: 'danger',
        text: error instanceof ApiError ? `${error.message}${error.detail ? ` — ${error.detail}` : ''}` : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="إعدادات المنصة"
      subtitle="ما كان يُضبط بتحرير ملف البيئة على المضيف: جهات اتصال الدعم، نطاقات الخدمة، الحدود الافتراضية، مفتاح الصيانة، وبيانات الفاتورة الضريبية (P-C4)."
      crumbs={['المنصة', 'المنصة', 'الإعدادات']}
      actions={
        <>
          <button className="btn" type="button" onClick={settings.reload}>
            تحديث
          </button>
          <button className="btn primary" type="button" disabled={!canWrite || busy} onClick={() => void save()}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ'}
          </button>
        </>
      }
    >
      {settings.status === 'loading' && <Loading rows={5} />}
      {settings.status === 'error' && <ErrorBox message={settings.error} onRetry={settings.reload} />}
      {settings.status === 'forbidden' && <Empty title="لا تملك صلاحية قراءة إعدادات المنصة" />}

      {settings.data && (
        <>
          {!canWrite && (
            <p className="alert warn">
              العرض للقراءة فقط: الكتابة تحتاج الرمز <code dir="ltr">console.settings.manage</code>.
            </p>
          )}
          {message && <p className={`alert ${message.kind === 'ok' ? 'ok' : 'danger'}`}>{message.text}</p>}

          <div className="card">
            <dl className="kv">
              <dt>البيئة</dt>
              <dd>
                <span className={`badge ${settings.data.environment.name === 'production' ? 'failed' : 'pending'}`}>
                  {settings.data.environment.labelAr}
                </span>{' '}
                <span className="muted small" dir="ltr">
                  {settings.data.environment.name}
                </span>
              </dd>
              <dt>عدد الإعدادات</dt>
              <dd>{settings.data.settings.length}</dd>
              <dt>النطاق</dt>
              <dd>المنصة كلها (تُطبَّق على كل عميل ما لم يكن له تجاوز خاص)</dd>
            </dl>
          </div>

          <div className="grid cols-2">
            {settings.data.settings.map((setting) => (
              <section className="card" key={setting.key}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <h2 style={{ marginBottom: 0 }}>{setting.labelAr}</h2>
                  <span className={`badge ${setting.isDefault ? 'planned' : 'ready'}`}>
                    {setting.isDefault ? 'القيمة الافتراضية' : 'مكتوبة'}
                  </span>
                </div>
                <p className="muted small">{setting.helpAr}</p>

                <label className="field">
                  <span dir="ltr">{setting.key}</span>
                  {setting.kind === 'boolean' ? (
                    <select
                      className="input"
                      disabled={!canWrite}
                      value={drafts[setting.key] ?? 'off'}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                      }
                    >
                      <option value="off">مُطفأ</option>
                      <option value="on">مُفعَّل</option>
                    </select>
                  ) : setting.kind === 'select' && (setting.options ?? []).length > 0 ? (
                    <select
                      className="input"
                      disabled={!canWrite}
                      value={drafts[setting.key] ?? ''}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                      }
                    >
                      {(setting.options ?? []).map((option, index) => (
                        <option key={option} value={option}>
                          {setting.optionLabels?.[index] ?? option}
                        </option>
                      ))}
                    </select>
                  ) : setting.kind === 'string-list' ? (
                    <textarea
                      className="input"
                      rows={4}
                      dir="ltr"
                      disabled={!canWrite}
                      value={drafts[setting.key] ?? ''}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                      }
                    />
                  ) : (
                    <input
                      className="input"
                      dir={setting.kind === 'email' ? 'ltr' : undefined}
                      type={setting.kind === 'integer' ? 'number' : 'text'}
                      disabled={!canWrite}
                      value={drafts[setting.key] ?? ''}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                      }
                    />
                  )}
                </label>

                <p className="muted small" style={{ margin: 0 }}>
                  {setting.updatedAt
                    ? `آخر تحديث ${new Date(setting.updatedAt).toLocaleString('ar-SA')}`
                    : 'لم تُكتب منذ إنشاء المنصة'}
                </p>
              </section>
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}
