import { Badge } from './badge';

export type Row = Record<string, string>;
export function SimpleTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return <div className="card" style={{ overflowX: 'auto' }}><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? String(index)}>{columns.map((column) => <td key={column}>{column === 'status' ? <Badge value={row[column] ?? 'ready'} /> : row[column]}</td>)}</tr>)}</tbody></table></div>;
}
