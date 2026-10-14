import { apiData, apiDelete, apiOpen, apiPost, apiPut } from './api';

export type WidgetKind = 'kpi' | 'chart' | 'table' | 'list';

export type DashboardSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  widgetCount: number;
  updatedAt: string;
};

export type CatalogItem = {
  key: string;
  titleAr: string;
  titleEn: string;
  kind: WidgetKind;
  unit: 'money' | 'count' | 'text';
  width: number;
  height: number;
  source: string;
  comparisonAr?: string;
};

export type DashboardWidget = {
  id: string;
  key: string;
  titleAr: string;
  kind: WidgetKind;
  positionX: number;
  positionY: number;
  width: number;
  height: number;
};

export type WidgetFigure = DashboardWidget & {
  unit: 'money' | 'count' | 'text';
  comparisonAr?: string;
  value?: string;
  previous?: string;
  deltaPercent?: string;
  direction?: 'up' | 'down' | 'flat';
  series?: { label: string; value: string }[];
  columns?: string[];
  rows?: string[][];
  error?: string;
  cached?: boolean;
};

export type DashboardDetail = {
  id: string;
  name: string;
  isDefault: boolean;
  widgets: DashboardWidget[];
};

export function listDashboards() {
  return apiData<DashboardSummary[]>('/dashboards');
}

export function getDashboard(id: string) {
  return apiData<DashboardDetail>(`/dashboards/${id}`);
}

export function dashboardData(id: string) {
  return apiData<{ dashboardId: string; generatedAt: string; widgets: WidgetFigure[] }>(`/dashboards/${id}/data`);
}

export function widgetCatalog() {
  return apiData<CatalogItem[]>('/dashboards/widgets/catalog');
}

export function createDashboard(name: string) {
  return apiPost<DashboardSummary>('/dashboards', { name });
}

export function addWidget(id: string, key: string) {
  return apiPost<DashboardWidget>(`/dashboards/${id}/widgets`, { key, config: {} });
}

export function saveLayout(id: string, widgets: DashboardWidget[]) {
  return apiPut<DashboardWidget[]>(`/dashboards/${id}/layout`, {
    widgets: widgets.map((widget) => ({
      widgetId: widget.id,
      positionX: widget.positionX,
      positionY: widget.positionY,
      width: widget.width,
      height: widget.height,
    })),
  });
}

export function removeWidget(id: string, widgetId: string) {
  return apiDelete<{ id: string }>(`/dashboards/${id}/widgets/${widgetId}`);
}

export function setDefaultDashboard(id: string) {
  return apiPost<{ id: string; isDefault: boolean }>(`/dashboards/${id}/default`, {});
}

export function deleteDashboard(id: string) {
  return apiDelete<{ id: string }>(`/dashboards/${id}`);
}

export async function downloadDashboardPdf(id: string): Promise<void> {
  const response = await apiOpen(`/dashboards/${id}/pdf`);
  if (!response.ok) throw new Error('تعذر تصدير PDF');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'dashboard.pdf';
  link.click();
  URL.revokeObjectURL(url);
}

/** يعيد رصّ الويدجتات بعد السحب حتى لا يتداخل مقاسان مختلفان. */
export function reorderWidgets<T extends DashboardWidget>(
  widgets: T[],
  fromId: string,
  toId: string,
): T[] {
  const ordered = [...widgets].sort((a, b) => a.positionY - b.positionY || a.positionX - b.positionX);
  const from = ordered.findIndex((widget) => widget.id === fromId);
  const to = ordered.findIndex((widget) => widget.id === toId);
  if (from < 0 || to < 0 || from === to) return widgets;
  const moved = ordered.splice(from, 1)[0];
  if (!moved) return widgets;
  ordered.splice(to, 0, moved);
  const placed: Array<Pick<DashboardWidget, 'positionX' | 'positionY' | 'width' | 'height'>> = [];
  return ordered.map((widget) => {
    const cell = firstFree(placed, widget.width, widget.height);
    placed.push(cell);
    return { ...widget, ...cell };
  });
}

function overlaps(
  a: Pick<DashboardWidget, 'positionX' | 'positionY' | 'width' | 'height'>,
  b: Pick<DashboardWidget, 'positionX' | 'positionY' | 'width' | 'height'>,
) {
  return a.positionX < b.positionX + b.width && b.positionX < a.positionX + a.width && a.positionY < b.positionY + b.height && b.positionY < a.positionY + a.height;
}

function firstFree(existing: Array<Pick<DashboardWidget, 'positionX' | 'positionY' | 'width' | 'height'>>, width: number, height: number) {
  for (let positionY = 0; positionY < 48; positionY += 1) {
    for (let positionX = 0; positionX <= 12 - width; positionX += 1) {
      const cell = { positionX, positionY, width, height };
      if (!existing.some((other) => overlaps(cell, other))) return cell;
    }
  }
  return { positionX: 0, positionY: existing.length * height, width, height };
}
