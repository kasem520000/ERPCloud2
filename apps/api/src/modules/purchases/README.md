# Purchases module

Phase 11 implements purchase invoices, purchase returns, additional invoice costs, landed-cost preview, and posting hooks.

## Landed cost rule

Additional costs are allocated across purchase lines by one of two methods:

- `value`: each line receives `total_costs * line.net / total_net`.
- `qty`: each line receives `total_costs * line.quantity / total_quantity`.

Allocations are rounded HALF_UP at four decimals by default. If rounding leaves a remainder, the remainder is assigned to the line with the largest allocation base. This keeps `sum(line.allocatedCost) === sum(cost.amount)` and makes the result deterministic.

Example with value allocation:

- line A: qty 2, net 100
- line B: qty 1, net 50
- costs: 10 + 5 + 0.01 = 15.01

Line A receives 10.0067, line B receives 5.0033. Effective unit cost is `(line.net + allocatedCost) / quantity`, so the inventory posting uses 55.0034 for line A and 55.0033 for line B.

## Posting

Posting is tenant-bound and atomic. In one transaction it:

1. Locks and validates the draft purchase invoice.
2. Allocates landed costs.
3. Posts inventory movements:
   - purchase: `direction=in`, `costing=inWithCost`
   - purchase return: `direction=out`, `costing=outAtAvg`
4. Optionally posts the supplied accounting journal lines.
5. Allocates a sequence-backed document number.
6. Marks the invoice posted and stores landed-cost snapshots per line.

Treasury vouchers and supplier portal features remain Phase 12+ scope.
