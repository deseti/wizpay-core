import { Injectable } from '@nestjs/common';
import { TaskDetails } from '../task/task.types';

@Injectable()
export class CircleService {
  async transfer(input: {
    to: string;
    amount: number;
    currency: string;
  }): Promise<{ txId: string }> {
    void input;

    return { txId: 'mock_tx_id' };
  }

  async preparePayrollPayout(task: TaskDetails) {
    return {
      adapter: 'circle',
      operation: 'payroll_payout',
      taskId: task.id,
      payload: task.payload,
      mode: 'placeholder',
    };
  }
}