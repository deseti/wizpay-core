import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { CreateTaskDto } from '../task/dto/create-task.dto';
import { TaskService } from '../task/task.service';

@Controller('tasks')
export class TaskController {
  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly taskService: TaskService,
  ) {}

  /**
   * POST /tasks — Create and enqueue a new task.
   *
   * This is the ONLY entry point for frontend task submission.
   * Frontend sends:
   *   { "type": "payroll", "payload": { ... } }
   *
   * Backend handles:
   *   - DTO validation (class-validator)
   *   - Task creation + state machine
   *   - Queue routing + agent execution
   */
  @Post()
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async createTask(@Body() body: CreateTaskDto) {
    return {
      data: await this.orchestratorService.handleTask(
        body.type,
        body.payload ?? {},
      ),
    };
  }

  /**
   * GET /tasks/:id — Poll task status.
   *
   * Frontend polls this endpoint to track progress.
   * Returns the full task with logs for fine-grained progress display.
   */
  @Get(':id')
  async getTask(@Param('id', new ParseUUIDPipe()) id: string) {
    return {
      data: await this.taskService.getTaskById(id),
    };
  }
}