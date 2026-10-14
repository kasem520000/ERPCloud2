import { Module } from '@nestjs/common';

import { EmployeeController, EmployeeHrmController } from './employee.controller.js';
import { EmployeeService } from './employee.service.js';

@Module({
  controllers: [EmployeeController, EmployeeHrmController],
  providers: [EmployeeService],
  exports: [EmployeeService],
})
export class EmployeeModule {}
