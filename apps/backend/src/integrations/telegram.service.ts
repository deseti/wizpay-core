import { Injectable } from '@nestjs/common';

@Injectable()
export class TelegramService {
  async notifyTaskUpdate(taskId: string, status: string, message: string) {
    return {
      taskId,
      status,
      message,
      channel: 'telegram',
      delivered: false,
    };
  }
}