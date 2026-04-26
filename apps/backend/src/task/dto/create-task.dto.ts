import { TaskType } from '../task-type.enum';
import { TaskPayload } from '../task.types';

export class CreateTaskDto {
  type!: TaskType;
  payload!: TaskPayload;
}