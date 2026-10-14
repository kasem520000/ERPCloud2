# Migration Registry Index

Generated registry summary for Phase 15.

| Wave | Entity | Legacy table | Target | Dependencies | Notes |
|---|---|---|---|---|---|
| W1 | company_profiles | Foundation | company_profiles |  | Foundation row becomes tenant company profile; secrets are never imported. |
| W1 | tenant_settings | SettingGeneral | tenant_settings |  | Distinct settings are emitted as typed tenant settings. |
| W2 | branches | Branches | branches |  | Missing branch code is generated from legacy PK. |
| W2 | warehouses | Stocks | warehouses | branches | Stocks are mapped to warehouses and branch lookup is deferred. |
| W2 | cash_locations | Safes | cash_locations | branches | Safes and banks become cash locations; balances are recomputed not trusted. |
| W2 | currencies | Currency | currencies |  | Currency_Lastprice imports later as FX; base currency selected from flags. |
| W3 | accounts | Accounts_Index | accounts |  | ParentCode repair report RC-12 emitted for missing parents. |
| W3 | fiscal_periods | AccountingPeriods | fiscal_periods | accounts | Multi-db fiscal years are provisional per RC-27. |
| W4 | parties | Customers | parties | accounts | Customers/Suppliers/Owners/Contractors/VAT clients converge to parties. |
| W4 | suppliers | Suppliers | parties | accounts | Supplier credit terms preserved as metadata. |
| W4 | salesmen | Employees | memberships |  | If HRM pack is absent only lightweight salesman references are staged. |
| W5 | item_categories | Category | item_categories |  | Deleted categories are archived and not used for balances. |
| W5 | units | units | units_of_measure |  | Unit ratios are validated in ItemUnits transform. |
| W5 | items | Items | items | item_categories, units | Barcodes, alternative codes, components and price history are child maps. |
| W6 | journal_entries | Entry | journal_entries | accounts, fiscal_periods | state=1 entries import as posted; unbalanced entries block. |
| W6 | journal_lines | Entry_sub | journal_entry_lines | journal_entries, accounts | Float values are rounded to minor units with variance payloads. |
| W7 | invoices | Inv | sales_or_purchase_invoices | parties, items | Document kind requires RC-resolved legacyDocTypeMap; unknown kinds block. |
| W7 | invoice_lines | Inv_Sub | invoice_lines | invoices, items | Computed totals are compared with header and issue variance rows. |
| W8 | inventory_replay | Inv_Sub | inventory_transactions | invoice_lines | Ledger is rebuilt from documents then compared with legacy stock functions. |
| W9 | vouchers | Receipts | vouchers | parties, cash_locations | Sand* and Receipts map uses inline RC-19 receipt/payment classification. |
| W10 | shift_closes | CasherClosed | shift_closes | cash_locations | Archive-grade import; no back-posting of already closed shifts. |
| W10 | fx_rates | Currency_Lastprice | fx_rates | currencies | Currency_SafeBalance is verify-only; FX rates use last known source date. |
| W13 | einvoice_artifacts | ZatcaResponse | einvoice_submissions | invoices | Legacy ZATCA artifacts import with status=imported and no resubmission. |
| W14 | attachments | AttachFiles | files |  | Attachment streaming copies bytes to S3; fixture stores metadata only. |
