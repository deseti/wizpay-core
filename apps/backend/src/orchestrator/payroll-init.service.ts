import { Injectable } from '@nestjs/common';
import { CreatePayrollTaskResult } from '../task/task.types';
import { TaskService } from '../task/task.service';

@Injectable()
export class PayrollInitService {
  constructor(private readonly taskService: TaskService) {}

  async prepare(payload: Record<string, unknown>): Promise<CreatePayrollTaskResult> {
    return this.taskService.createPayrollTask(payload);
  }
}
