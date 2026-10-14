import { describe, expect, it } from 'vitest';

import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('renders Prometheus counters, latency buckets and business gauges', () => {
    const metrics = new MetricsService();
    metrics.observeHttp('GET', '/api/v1/sales', 200, 12);
    metrics.observeHttp('GET', '/api/v1/sales', 503, 80);
    metrics.recordEinvoiceFailure();
    metrics.addMigrationThroughput(42);
    const body = metrics.renderPrometheus({ pending: 7, published: 19, dead: 2 });
    expect(body).toContain('erp_up 1');
    expect(body).toContain('erp_http_requests_total{method="GET",route="/api/v1/sales",status_class="5xx"} 1');
    expect(body).toContain('erp_queue_depth{queue="outbox",status="pending"} 7');
    expect(body).toContain('erp_queue_depth{queue="outbox",status="published"} 19');
    expect(body).toContain('erp_queue_depth{queue="outbox",status="dead"} 2');
    expect(body).toContain('erp_einvoice_failures_total 1');
    expect(body).toContain('erp_migration_imported_rows_total 42');
  });

  it('defaults outbox queue depth to zero when no snapshot or DB handle is provided', async () => {
    const metrics = new MetricsService();
    const body = await metrics.scrapePrometheus();
    expect(body).toContain('erp_queue_depth{queue="outbox",status="pending"} 0');
    expect(body).toContain('erp_queue_depth{queue="outbox",status="published"} 0');
    expect(body).toContain('erp_queue_depth{queue="outbox",status="dead"} 0');
  });
});
