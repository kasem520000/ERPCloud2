'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { StatTile, StatTiles, Tabs } from '../../../components/ui';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import {
  arabicName,
  branchOptions,
  defaultOf,
  itemLabel,
  listBranches,
  listItems,
  listWarehouses,
  quantity,
  shortDate,
  statusLabel,
  type Branch,
  type Item,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type RequestLine = { lineNo: number; itemId: string; qty: string; approvedQty: string | null; note: string | null };
type GoodsRequest = {
  id: string;
  number: string;
  status: string;
  branchId: string;
  toWarehouseId: string;
  fromWarehouseId: string | null;
  requestedAt: string;
  neededBy: string | null;
  notes: string | null;
  rejectionReason: string | null;
  transferId: string | null;
  lines: RequestLine[];
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  submitted: 'بانتظار الاعتماد',
  approved: 'معتمد',
  rejected: 'مرفوض',
  fulfilled: 'نُفّذ بمناقلة',
  cancelled: 'ملغى',
};

const FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'الكل' },
  { value: 'draft', label: 'مسودة' },
  { value: 'submitted', label: 'بانتظار الاعتماد' },
  { value: 'approved', label: 'معتمد' },
  { value: 'fulfilled', label: 'نُفّذ' },
  { value: 'rejected', label: 'مرفوض' },
];

type DraftLine = { itemId: string; qtyText: string; note: string };
const emptyLine = (): DraftLine => ({ itemId: '', qtyText: '', note: '' });

export default function GoodsRequestsPage() {
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const requests = useQuery<GoodsRequest[]>(() => apiList<GoodsRequest>(`/inventory/requests${status ? `?status=${status}` : ''}`), [status]);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const warehouseRows = warehouses.data ?? [];
  const itemRows = items.data ?? [];

  const [open, setOpen] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [toWarehouseId, setTo] = useState('');
  const [fromWarehouseId, setFrom] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  // The decision panel is the approval screen: quantities may be cut down, and a rejection
  // has to carry a reason, so both live in one place instead of a bare confirm dialog.
  const [decision, setDecision] = useState<GoodsRequest | null>(null);
  const [decisionSource, setDecisionSource] = useState('');
  const [approvedQty, setApprovedQty] = useState<Record<number, string>>({});
  const [rejectReason, setRejectReason] = useState('');

  const branchChoices = branchOptions(branches.data ?? []);
  const defaultBranch = defaultOf(branches.data ?? []) ?? (branches.data ?? [])[0];
  const currentBranch = branchId || defaultBranch?.id || '';
  const nameOfWarehouse = (id: string | null) => {
    if (!id) return '—';
    const warehouse = warehouseRows.find((row) => row.id === id);
    return warehouse ? arabicName(warehouse) : id;
  };
  const nameOfItem = (id: string) => {
    const item = itemRows.find((row) => row.id === id);
    return item ? itemLabel(item) : id;
  };

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, position) => (position === index ? { ...line, ...patch } : line)));
  }

  async function act(action: () => Promise<unknown>, okText: string) {
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      requests.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  async function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const filled = lines.filter((line) => line.itemId && Number(line.qtyText) > 0);
      if (filled.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'أضف سطراً واحداً على الأقل بكمية أكبر من صفر.');
      await apiPost('/inventory/requests', {
        branchId: currentBranch,
        toWarehouseId,
        fromWarehouseId: fromWarehouseId || undefined,
        neededBy: neededBy || undefined,
        notes: notes || undefined,
        lines: filled.map((line) => ({ itemId: line.itemId, qty: line.qtyText, note: line.note || undefined })),
      });
      setNotice({ kind: 'ok', text: 'تم حفظ الطلب كمسودة. أرسِله للاعتماد ليراه المستودع المورِّد.' });
      setLines([emptyLine()]);
      setNotes('');
      setNeededBy('');
      requests.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  function openDecision(request: GoodsRequest) {
    setDecision(request);
    setDecisionSource(request.fromWarehouseId ?? '');
    setApprovedQty(Object.fromEntries(request.lines.map((line) => [line.lineNo, line.qty])));
    setRejectReason('');
  }

  async function approve() {
    if (!decision) return;
    await act(
      () =>
        apiPost(`/inventory/requests/${decision.id}/approve`, {
          fromWarehouseId: decisionSource || undefined,
          lines: decision.lines.map((line) => ({ lineNo: line.lineNo, approvedQty: approvedQty[line.lineNo] ?? line.qty })),
        }),
      'تم اعتماد الطلب. نفِّذه بمناقلة لتحويل الكميات المعتمدة.',
    );
    setDecision(null);
  }

  async function reject() {
    if (!decision) return;
    await act(() => apiPost(`/inventory/requests/${decision.id}/reject`, { reason: rejectReason }), 'تم رفض الطلب.');
    setDecision(null);
  }

  const requestRows = requests.data ?? [];
  const count = (value: string) => requestRows.filter((row) => row.status === value).length;
  const requestedQty = requestRows.reduce(
    (sum, row) => sum + row.lines.reduce((inner, line) => inner + Number(line.qty), 0),
    0,
  );

  return (
    <Screen
      title="طلب بضاعة"
      subtitle="طلب داخلي من فرع أو مستودع: مسودة ← اعتماد (بكميات قد تقل عن المطلوب) ← تنفيذ بمناقلة. الطلب نفسه لا يحرّك المخزون."
      crumbs={['المستودعات', 'العمليات']}
      actions={
        can('inventory.request.manage') ? (
          <button className="btn primary" type="button" onClick={() => setOpen(!open)}>
            {open ? 'إغلاق' : 'طلب جديد'}
          </button>
        ) : null
      }
    >
      {open && (
        <form className="card" onSubmit={submitRequest}>
          <h2>طلب بضاعة جديد</h2>
          <div className="form-grid">
            <label className="field">
              <span>الفرع *</span>
              <select className="input" value={currentBranch} onChange={(event) => setBranchId(event.target.value)} required>
                <option value="">— اختر —</option>
                {branchChoices.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>المستودع الطالب *</span>
              <select className="input" value={toWarehouseId} onChange={(event) => setTo(event.target.value)} required>
                <option value="">— اختر —</option>
                {warehouseRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>المستودع المورِّد</span>
              <select className="input" value={fromWarehouseId} onChange={(event) => setFrom(event.target.value)}>
                <option value="">— يُحدَّد عند الاعتماد —</option>
                {warehouseRows.filter((row) => row.id !== toWarehouseId).map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>مطلوب بتاريخ</span>
              <input className="input" dir="ltr" type="date" value={neededBy} onChange={(event) => setNeededBy(event.target.value)} />
            </label>
            <label className="field wide">
              <span>ملاحظات</span>
              <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="سبب الطلب أو تفاصيل النواقص" />
            </label>
          </div>

          <h3>الأصناف المطلوبة</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المادة</th>
                  <th>الكمية</th>
                  <th>ملاحظة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td>
                      <select className="input" value={line.itemId} onChange={(event) => updateLine(index, { itemId: event.target.value })}>
                        <option value="">— اختر —</option>
                        {itemRows.map((row) => (
                          <option key={row.id} value={row.id}>
                            {itemLabel(row)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input className="input" dir="ltr" inputMode="decimal" value={line.qtyText} onChange={(event) => updateLine(index, { qtyText: event.target.value })} />
                    </td>
                    <td>
                      <input className="input" value={line.note} onChange={(event) => updateLine(index, { note: event.target.value })} />
                    </td>
                    <td>
                      <button className="btn sm" type="button" onClick={() => setLines((current) => current.filter((_, position) => position !== index))}>
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn sm" type="button" onClick={() => setLines((current) => [...current, emptyLine()])}>
            + سطر
          </button>

          <Notice notice={notice} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ كمسودة'}
          </button>
        </form>
      )}

      {decision && (
        <div className="card">
          <h2>قرار الطلب {decision.number}</h2>
          <p className="muted">اعتمد الكميات كما هي أو خفِّضها بما يسمح به رصيد المستودع المورِّد.</p>
          <div className="form-grid">
            <label className="field">
              <span>المستودع المورِّد *</span>
              <select className="input" value={decisionSource} onChange={(event) => setDecisionSource(event.target.value)} required>
                <option value="">— اختر —</option>
                {warehouseRows.filter((row) => row.id !== decision.toWarehouseId).map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المادة</th>
                  <th>المطلوب</th>
                  <th>المعتمد</th>
                </tr>
              </thead>
              <tbody>
                {decision.lines.map((line) => (
                  <tr key={line.lineNo}>
                    <td>{nameOfItem(line.itemId)}</td>
                    <td className="num">{quantity(line.qty)}</td>
                    <td>
                      <input
                        className="input"
                        dir="ltr"
                        inputMode="decimal"
                        value={approvedQty[line.lineNo] ?? line.qty}
                        onChange={(event) => setApprovedQty((current) => ({ ...current, [line.lineNo]: event.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="field wide">
            <span>سبب الرفض (عند الرفض فقط)</span>
            <input className="input" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="مثال: لا يوجد رصيد كافٍ" />
          </label>
          <div className="row">
            <button className="btn primary" type="button" onClick={approve}>
              اعتماد
            </button>
            <button className="btn danger" type="button" onClick={reject} disabled={!rejectReason.trim()}>
              رفض
            </button>
            <button className="btn" type="button" onClick={() => setDecision(null)}>
              إغلاق
            </button>
          </div>
        </div>
      )}

      <StatTiles>
        <StatTile label="طلبات البضاعة" value={requestRows.length} hint="طلب مسجّل" tone="brand" />
        <StatTile
          label="بانتظار الاعتماد"
          value={count('submitted')}
          hint="تحتاج قرار المستودع المورِّد"
          tone={count('submitted') > 0 ? 'warn' : 'ok'}
        />
        <StatTile label="معتمد" value={count('approved')} hint="جاهز للتنفيذ بمناقلة" tone="ok" />
        <StatTile label="نُفّذ" value={count('fulfilled')} hint="تحوّل إلى مناقلة" />
        <StatTile label="مرفوض" value={count('rejected')} hint="مرفوض من المورِّد" tone="danger" />
        <StatTile label="الكمية المطلوبة" value={quantity(requestedQty)} hint="مجموع كل الطلبات" />
      </StatTiles>

      <Tabs
        items={FILTERS.map((filter) => ({ id: filter.value, label: filter.label }))}
        value={status}
        onChange={setStatus}
      />

      {!open && !decision && <Notice notice={notice} />}

      <QueryView query={requests} empty="لا توجد طلبات بضاعة" emptyDetail="أنشئ طلباً ليعتمده المستودع المورِّد ثم يُنفَّذ بمناقلة.">
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            columns={[
              { key: 'number', header: 'الرقم', align: 'ltr', cell: (row) => row.number },
              { key: 'to', header: 'المستودع الطالب', cell: (row) => nameOfWarehouse(row.toWarehouseId) },
              { key: 'from', header: 'المورِّد', cell: (row) => nameOfWarehouse(row.fromWarehouseId) },
              { key: 'lines', header: 'الأصناف', align: 'num', cell: (row) => row.lines.length },
              { key: 'qty', header: 'المطلوب', align: 'num', cell: (row) => quantity(row.lines.reduce((sum, line) => sum + Number(line.qty), 0)) },
              {
                key: 'approved',
                header: 'المعتمد',
                align: 'num',
                cell: (row) => (row.lines.some((line) => line.approvedQty !== null) ? quantity(row.lines.reduce((sum, line) => sum + Number(line.approvedQty ?? 0), 0)) : '—'),
              },
              { key: 'needed', header: 'مطلوب بتاريخ', align: 'ltr', cell: (row) => (row.neededBy ? shortDate(row.neededBy) : '—') },
              {
                key: 'status',
                header: 'الحالة',
                cell: (row) => (
                  <span className="badge" title={row.rejectionReason ?? undefined}>
                    {STATUS_LABELS[row.status] ?? statusLabel(row.status)}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                cell: (row) => (
                  <span className="row">
                    {row.status === 'draft' && can('inventory.request.manage') && (
                      <button className="btn sm primary" type="button" onClick={() => act(() => apiPost(`/inventory/requests/${row.id}/submit`, {}), 'تم إرسال الطلب للاعتماد.')}>
                        إرسال للاعتماد
                      </button>
                    )}
                    {row.status === 'submitted' && can('inventory.request.approve') && (
                      <button className="btn sm primary" type="button" onClick={() => openDecision(row)}>
                        اعتماد / رفض
                      </button>
                    )}
                    {row.status === 'approved' && can('inventory.request.approve') && (
                      <button className="btn sm primary" type="button" onClick={() => act(() => apiPost(`/inventory/requests/${row.id}/fulfil`, {}), 'أُنشئت مناقلة مسودة بالكميات المعتمدة.')}>
                        تنفيذ بمناقلة
                      </button>
                    )}
                    {['draft', 'submitted', 'approved'].includes(row.status) && can('inventory.request.manage') && (
                      <button className="btn sm danger" type="button" onClick={() => act(() => apiPost(`/inventory/requests/${row.id}/cancel`, {}), 'تم إلغاء الطلب.')}>
                        إلغاء
                      </button>
                    )}
                    {row.transferId && (
                      <a className="btn sm" href="/inventory/transfers">
                        المناقلة
                      </a>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
