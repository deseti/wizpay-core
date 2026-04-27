import { IsEnum, IsObject, IsOptional } from 'class-validator';
import { TaskType } from '../task-type.enum';
import type { TaskPayload } from '../task.types';

export class CreateTaskDto {
  @IsEnum(TaskType, {
    message: `type must be one of: ${Object.values(TaskType).join(', ')}`,
  })
  type!: TaskType;

  @IsOptional()
  @IsObject({ message: 'payload must be a JSON object' })
  payload!: TaskPayload;
}