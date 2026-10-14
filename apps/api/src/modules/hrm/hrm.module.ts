import { Module } from '@nestjs/common';

import { AccountingModule } from '../accounting/accounting.module.js';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module.js';
import { TreasuryModule } from '../treasury/treasury.module.js';

import { HrmController } from './hrm.controller.js';
import { HrmService } from './hrm.service.js';
import { PayrollComplianceService } from './payroll-compliance.service.js';

@Module({
  imports: [AccountingModule, TreasuryModule, CustomFieldsModule],
  controllers: [HrmController],
  providers: [HrmService, PayrollComplianceService],
  exports: [HrmService, PayrollComplianceService],
})
export class HrmModule {}
