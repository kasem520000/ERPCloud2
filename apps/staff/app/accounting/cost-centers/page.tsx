'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { ApiError, apiData, apiDelete, apiPatch, apiPost } from '../../../lib/api';
import { money } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 🌳 مراكز التكلفة — `Form_WPF/frmCostCenter.xaml` («مركز التكلفة 🏢»).
 *
 * The window is a card beside a tree, and so is this screen:
 * `📝 بيانات مركز التكلفة` — `🔢 الرقم` · `✏️ الاسم` · `🌐 الاسم EN` · `📂 البند الرئيسي` ·
 * `🏬 الفرع` · `🏷️ النوع` (`🟢 رئيسي` / `🔵 فرعي`) — with `➕ جديد` · `💾 حفظ` · `🗑️ حذف`,
 * and `🌳 شجرة مراكز التكلفة`, which the window builds by walking `ParentCode`
 * (`LoadTree` / `BuildTreeNodes`).
 *
 * What the cloud was missing is the figure beside each node: the list answered with
 * centres and no balances at all, so a centre could not be asked what it had spent. The
 * balance is the part-one rule applied to centres — posted entries only, and a parent
 * carrying its children — so the number on this tree and the number at the foot of
 * 📊 كشف مركز الكلفة are the same number.
 */
type CostCenter = {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  parentId?: string | null;
  branchId?: string | null;
  parentName?: string | null;
  level?: number;
  kind?: 'main' | 'sub';
  balance?: {
    ownBalance?: string;
    debit?: string;
    credit?: string;
    balance?: string;
    children?: number;
  };
};

type Branch = { id: string; nameAr?: string; name?: string };

/** One node of 🌳 شجرة مراكز التكلفة. */
type Node = CostCenter & { children: Node[] };

const blank = { code: '', nameAr: '', nameEn: '', parentId: '', branchId: '' };

export default function CostCentersPage() {
  const { can } = useSession();
  const centers = useQuery<CostCenter[]>(() => apiData<CostCenter[]>('/cost-centers?with_balances=1'), []);
  const branches = useQuery<Branch[]>(() => apiData<Branch[]>('/branches'), []);
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState('');
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const rows = centers.data ?? [];
  const manage = can('accounting.account.manage');

  const tree = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, { ...row, children: [] as Node[] }]));
    const roots: Node[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sort = (nodes: Node[]) => {
      nodes.sort((left, right) => left.code.localeCompare(right.code));
      for (const node of nodes) sort(node.children);
    };
    sort(roots);
    return roots;
  }, [rows]);

  const totals = useMemo(
    () => ({
      count: rows.length,
      spent: rows
        .filter((row) => !row.parentId)
        .reduce((sum, row) => sum + Number(row.balance?.debit ?? 0), 0),
      credited: rows
        .filter((row) => !row.parentId)
        .reduce((sum, row) => sum + Number(row.balance?.credit ?? 0), 0),
      used: rows.filter((row) => Number(row.balance?.balance ?? 0) !== 0).length,
    }),
    [rows],
  );

  function startEdit(row: CostCenter) {
    setEditingId(row.id);
    setForm({
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn ?? '',
      parentId: row.parentId ?? '',
      branchId: row.branchId ?? '',
    });
    setNotice(undefined);
  }

  function reset() {
    setEditingId('');
    setForm(blank);
  }

  async function save() {
    setBusy(true);
    setNotice(undefined);
    const payload = {
      code: form.code.trim(),
      nameAr: form.nameAr.trim(),
      nameEn: form.nameEn.trim() || undefined,
      parentId: form.parentId || null,
      branchId: form.branchId || null,
    };
    try {
      if (editingId) {
        await apiPatch(`/cost-centers/${editingId}`, payload);
        setNotice({ kind: 'ok', text: `تم حفظ مركز التكلفة ${payload.code}.` });
      } else {
        await apiPost('/cost-centers', payload);
        setNotice({ kind: 'ok', text: `تم إنشاء مركز التكلفة ${payload.code}.` });
      }
      reset();
      centers.reload();
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? `${error.message}${error.detail ? ` — ${error.detail}` : ''}` : 'تعذر الحفظ.',
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: CostCenter) {
    if (!window.confirm(`هل تريد حذف مركز التكلفة ${row.code} — ${row.nameAr}؟`)) return;
    setNotice(undefined);
    try {
      await apiDelete(`/cost-centers/${row.id}`);
      setNotice({ kind: 'ok', text: `تم حذف مركز التكلفة ${row.code}.` });
      if (editingId === row.id) reset();
      centers.reload();
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? `${error.message}${error.detail ? ` — ${error.detail}` : ''}` : 'تعذر الحذف.',
      });
    }
  }

  if (centers.status === 'loading') return <Loading />;
  if (centers.status === 'forbidden') return <Forbidden />;
  if (centers.status === 'error') return <ErrorBox message={centers.error} onRetry={centers.reload} />;

  return (
    <Screen
      title="مركز التكلفة 🏢"
      subtitle="تُستخدم لتوزيع المصروفات والإيرادات على الأنشطة والفروع، وكل مركز برصيده من القيود المرحّلة."
      crumbs={['المحاسبة', 'تعاريف']}
      actions={
        <Link className="btn" href="/reports/cost-center-balances">
          📊 كشف مركز الكلفة
        </Link>
      }
    >
      <StatTiles>
        <StatTile label="🌳 عدد المراكز" value={totals.count} />
        <StatTile label="💸 إنفاق المراكز الرئيسية" value={money(totals.spent.toFixed(2))} tone="ok" />
        <StatTile label="💰 أرصدة دائنة" value={money(totals.credited.toFixed(2))} tone="brand" />
        <StatTile label="📌 مراكز عليها حركة" value={totals.used} hint="رصيدها غير صفر" />
      </StatTiles>

      <div className="grid two">
        <section className="card">
          <h2 style={{ marginTop: 0 }}>📝 بيانات مركز التكلفة</h2>
          <div className="form-grid">
            <label className="field">
              <span>🔢 الرقم *</span>
              <input
                className="input"
                dir="ltr"
                value={form.code}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
              />
            </label>
            <label className="field">
              <span>✏️ الاسم *</span>
              <input
                className="input"
                value={form.nameAr}
                onChange={(event) => setForm({ ...form, nameAr: event.target.value })}
              />
            </label>
            <label className="field">
              <span>🌐 الاسم EN</span>
              <input
                className="input"
                dir="ltr"
                value={form.nameEn}
                onChange={(event) => setForm({ ...form, nameEn: event.target.value })}
              />
            </label>
            <label className="field">
              <span>📂 البند الرئيسي</span>
              <select
                className="input"
                value={form.parentId}
                onChange={(event) => setForm({ ...form, parentId: event.target.value })}
              >
                <option value="">— بلا (مركز رئيسي)</option>
                {rows
                  .filter((row) => row.id !== editingId)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.code} — {row.nameAr}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>🏬 الفرع</span>
              <select
                className="input"
                value={form.branchId}
                onChange={(event) => setForm({ ...form, branchId: event.target.value })}
              >
                <option value="">— كل الفروع —</option>
                {(branches.data ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.nameAr ?? branch.name ?? branch.id}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>🏷️ النوع</span>
              <div className="row" style={{ gap: 6 }}>
                <span className={`badge${form.parentId ? '' : ' active'}`}>
                  {form.parentId ? '🔵 فرعي' : '🟢 رئيسي'}
                </span>
                <span className="muted small">يُقرأ من «البند الرئيسي»</span>
              </div>
            </div>
          </div>
          {notice && <p className={`alert ${notice.kind}`}>{notice.text}</p>}
          {manage && (
            <div className="toolbar">
              <button className="btn primary" type="button" disabled={busy || !form.code || !form.nameAr} onClick={() => void save()}>
                💾 حفظ
              </button>
              <button className="btn" type="button" disabled={busy} onClick={reset}>
                ➕ جديد
              </button>
              {editingId && (
                <button
                  className="btn danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(rows.find((row) => row.id === editingId)!)}
                >
                  🗑️ حذف
                </button>
              )}
            </div>
          )}
        </section>

        <section className="card tight">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>🌳 شجرة مراكز التكلفة</h2>
            <button className="btn sm" type="button" onClick={() => setOpen(!open)}>
              {open ? 'طي الكل' : 'توسيع الكل'}
            </button>
          </div>
          <div className="tree" style={{ marginTop: 8 }}>
            <Nodes nodes={tree} depth={0} open={open} onEdit={startEdit} onRemove={(row) => void remove(row)} manage={manage} />
          </div>
        </section>
      </div>
    </Screen>
  );
}

function Nodes({
  nodes,
  depth,
  open,
  onEdit,
  onRemove,
  manage,
}: {
  nodes: Node[];
  depth: number;
  open: boolean;
  onEdit: (row: CostCenter) => void;
  onRemove: (row: CostCenter) => void;
  manage: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <>
      {nodes.map((node) => {
        const isOpen = expanded[node.id] ?? open;
        return (
          <div key={node.id}>
            <div className="tree-row" style={{ paddingInlineStart: 8 + depth * 18 }}>
              {node.children.length > 0 ? (
                <button
                  className="btn sm"
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded({ ...expanded, [node.id]: !isOpen })}
                >
                  {isOpen ? '−' : '+'}
                </button>
              ) : (
                <span style={{ display: 'inline-block', width: 26 }} />
              )}
              <button className="tree-label" type="button" onClick={() => onEdit(node)}>
                <span dir="ltr">{node.code}</span> {node.nameAr}
                <span className="badge" style={{ marginInlineStart: 6 }}>
                  {node.parentId ? '🔵 فرعي' : '🟢 رئيسي'}
                </span>
              </button>
              <span className="tree-balance num" dir="ltr">
                {money(Number(node.balance?.balance ?? 0).toFixed(2))}
              </span>
              <Link className="btn sm" href={`/accounting/cost-center-statement?center=${node.id}`}>
                📊
              </Link>
              {manage && (
                <button className="btn sm danger" type="button" onClick={() => onRemove(node)} aria-label="حذف">
                  🗑️
                </button>
              )}
            </div>
            {isOpen && node.children.length > 0 && (
              <Nodes nodes={node.children} depth={depth + 1} open={open} onEdit={onEdit} onRemove={onRemove} manage={manage} />
            )}
          </div>
        );
      })}
      {nodes.length === 0 && <p className="empty">لا توجد مراكز تكلفة بعد.</p>}
    </>
  );
}
