import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { CreateTaskDto } from '../task/dto/create-task.dto';
import { TaskService } from '../task/task.service';

@Controller('tasks')
export class TaskController {
  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly taskService: TaskService,
  ) {}

  @Post()
  async createTask(@Body() body: CreateTaskDto) {
    return this.orchestratorService.handleTask(body.type, body.payload ?? {});
  }

  @Get(':id')
  async getTask(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.taskService.getTaskById(id);
  }
}