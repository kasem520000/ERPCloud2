'use client';

import { useMemo, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../../components/screen';
import { money } from '../../../../lib/lookups';
import { useQuery } from '../../../../lib/use-query';
import {
  ACCOUNT_TYPE_LABELS,
  balanceOf,
  listAccountDirectory,
  nameOf,
  parentOf,
  postableOf,
  typeOf,
  type Account,
} from '../../../../lib/accounts';

/** 📂 شجرة الحسابات — `frmAccountsDirectory.xaml`: `MaxLevel = 3`, `ExpandToLevel(0..3)`. */
const LEVELS = [
  { id: '0', label: '0' },
  { id: '1', label: '1' },
  { id: '2', label: '2' },
  { id: '3', label: '3' },
] as const;

type TreeNode = Account & { children: TreeNode[] };

function buildTree(accounts: Account[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const account of accounts) byId.set(account.id, { ...account, children: [] });

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parentId = parentOf(node);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((left, right) => left.code.localeCompare(right.code));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

function Node({ node, depth, expanded, toggle }: { node: TreeNode; depth: number; expanded: Set<string>; toggle: (id: string) => void }) {
  const open = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <tr>
        <td style={{ paddingInlineStart: 10 + depth * 20 }}>
          {hasChildren ? (
            <button className="btn sm" type="button" onClick={() => toggle(node.id)} aria-expanded={open}>
              {open ? '−' : '+'}
            </button>
          ) : (
            <span style={{ display: 'inline-block', width: 22 }} />
          )}{' '}
          <span dir="ltr">{node.code}</span>
        </td>
        <td>{nameOf(node)}</td>
        <td>{ACCOUNT_TYPE_LABELS[typeOf(node)] ?? typeOf(node)}</td>
        <td>{postableOf(node) ? <span className="badge active">ترحيل</span> : <span className="badge">تجميعي</span>}</td>
        <td className="num">{node.children.length || ''}</td>
        <td className="num" dir="ltr">{money(balanceOf(node).toFixed(4))}</td>
      </tr>
      {open && node.children.map((child) => <Node key={child.id} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} />)}
    </>
  );
}

export default function AccountTreePage() {
  const accounts = useQuery<Account[]>(() => listAccountDirectory(), []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState('1');

  const tree = useMemo(() => buildTree(accounts.data ?? []), [accounts.data]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expandAll = () => setExpanded(new Set((accounts.data ?? []).map((account) => account.id)));

  /** مستويات التوسعة — open the tree down to the level the desktop caps at (3). */
  const expandToLevel = (target: number) => {
    const ids = new Set<string>();
    const walk = (id: string, depth: number) => {
      ids.add(id);
      if (depth >= target) return;
      for (const child of accounts.data ?? []) {
        if (parentOf(child) === id) walk(child.id, depth + 1);
      }
    };
    for (const account of accounts.data ?? []) {
      if (!parentOf(account)) walk(account.id, 0);
    }
    setExpanded(ids);
  };

  return (
    <Screen
      title="شجرة الحسابات"
      subtitle="عرض هرمي لدليل الحسابات بالمستويات، وكل فرع برصيده من القيود المرحّلة فقط."
      crumbs={['المحاسبة', 'تعاريف']}
      actions={
        <>
          <button className="btn" type="button" onClick={expandAll}>
            توسيع الكل
          </button>
          <button className="btn" type="button" onClick={() => setExpanded(new Set())}>
            طي الكل
          </button>
          <span className="muted small" style={{ alignSelf: 'center' }}>مستويات التوسعة:</span>
          {LEVELS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`btn sm${level === entry.id ? ' primary' : ''}`}
              onClick={() => {
                setLevel(entry.id);
                expandToLevel(Number(entry.id));
              }}
            >
              {entry.label}
            </button>
          ))}
          <button className="btn" type="button" onClick={() => window.print()}>
            طباعة
          </button>
        </>
      }
    >
      {accounts.status === 'loading' && <Loading />}
      {accounts.status === 'forbidden' && <Forbidden />}
      {accounts.status === 'error' && <ErrorBox message={accounts.error} onRetry={accounts.reload} />}
      {accounts.status === 'success' &&
        (tree.length === 0 ? (
          <Empty title="لا توجد حسابات بعد" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th>الاسم</th>
                  <th>النوع</th>
                  <th>الحالة</th>
                  <th className="num">فروع</th>
                  <th className="num">الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {tree.map((node) => (
                  <Node key={node.id} node={node} depth={0} expanded={expanded} toggle={toggle} />
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Screen>
  );
}
