/**
 * @erp/ui — ERPCloud Design System v3.
 *
 * One barrel, imported by `apps/staff`, `apps/platform-admin` and
 * `apps/marketing`. A component that exists here exists once; a screen that
 * needs a second copy of it is a defect, not a preference (ADR-030).
 *
 * The CSS half of the system is `@erp/ui/tokens.css`, imported by each app's
 * `globals.css` — never copied between them.
 */

/* ---------------------------------------------------------------- theme -- */
export {
  ThemeProvider,
  useTheme,
  ThemeScript,
  type ThemeProviderProps,
} from './theme/theme-provider';
export { ThemeToggle, type ThemeToggleProps } from './theme/theme-toggle';
export {
  THEME_STORAGE_KEY,
  THEME_EVENT,
  applyTheme,
  isThemeChoice,
  nextThemeChoice,
  readThemeChoice,
  resolveTheme,
  systemPrefersDark,
  themeInitScript,
  writeThemeChoice,
  type ResolvedTheme,
  type ThemeChoice,
} from './theme/theme';

/* ------------------------------------------------------------------ lib -- */
export { cn, type ClassValue } from './lib/cn';
export {
  formatCompactMoney,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  formatPosition,
  groupDigits,
  toWesternDigits,
  type MoneyFormatOptions,
} from './lib/format';

/* --------------------------------------------------------------- design -- */
export { DesignGallery, DesignGalleryWithToasts } from './design/gallery';

/* ------------------------------------------------------------ components -- */
export { Button, Spinner, type ButtonProps, type ButtonSize, type ButtonVariant } from './components/button';
export {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  type CardProps,
} from './components/card';
export {
  Badge,
  CellBadge,
  STATUS_TONES,
  statusTone,
  type BadgeProps,
  type StatusTone,
} from './components/status';
export { Kpi, Sparkline, type KpiProps, type KpiTone, type SparklineProps } from './components/kpi';
export {
  DataTable,
  type Column,
  type DataTableProps,
  type SortState,
  type TableLabels,
  type TableState,
} from './components/data-table';
export { FilterBar, type FilterBarProps } from './components/filter-bar';
export {
  Modal,
  Drawer,
  ConfirmDialog,
  type DrawerProps,
  type ModalProps,
} from './components/modal';
export { Tabs, SegmentedTabs, type SegmentedTabsProps, type TabItem, type TabsProps } from './components/tabs';
export {
  Combobox,
  DateRangePicker,
  Input,
  MoneyField,
  SearchInput,
  Select,
  normalizeArabic,
  type ComboboxOption,
  type ComboboxProps,
  type DateRange,
  type DateRangePickerProps,
  type InputProps,
  type MoneyFieldProps,
  type SelectProps,
} from './components/input';
export { ToastProvider, useToast, type Toast as ToastMessage, type ToastTone } from './components/toast';
export { Tooltip, type TooltipProps } from './components/tooltip';
export { Skeleton, SkeletonCard, SkeletonRows } from './components/skeleton';
export { EmptyState, type EmptyStateProps, type EmptyStateTone } from './components/empty-state';
export { Avatar, initials, type AvatarProps, type AvatarSize } from './components/avatar';
export { Meter, Progress, type MeterProps, type ProgressProps } from './components/progress';
export {
  AXIS_STYLE,
  BarSeries,
  ChartLegend,
  Donut,
  LineSeries,
  type ChartDatum,
  type ChartLegendItem,
  type DonutProps,
  type SeriesChartProps,
} from './components/chart';
export { PageBreak, PrintQr, PrintSheet, type PrintSheetProps } from './components/print-sheet';
export { KeyboardHint, PosKeyHints, type KeyboardHintProps } from './components/keyboard-hint';
export { CountUp, Marquee, Reveal, type CountUpProps, type MarqueeProps, type RevealProps } from './components/motion';
