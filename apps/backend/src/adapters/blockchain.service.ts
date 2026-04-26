import { Injectable } from '@nestjs/common';
import { TaskDetails } from '../task/task.types';

@Injectable()
export class BlockchainService {
  async preparePayrollContractCall(task: TaskDetails) {
    return {
      adapter: 'blockchain',
      operation: 'payroll_contract_call',
      taskId: task.id,
      payload: task.payload,
      mode: 'placeholder',
    };
  }

  async prepareBridgeTransfer(task: TaskDetails) {
    return {
      adapter: 'blockchain',
      operation: 'bridge_contract_call',
      taskId: task.id,
      payload: task.payload,
      mode: 'placeholder',
    };
  }
}