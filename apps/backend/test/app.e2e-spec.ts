import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { OrchestratorService } from '../src/orchestrator/orchestrator.service';
import { TaskStatus } from '../src/task/task-status.enum';
import { TaskService } from '../src/task/task.service';
import { TaskType } from '../src/task/task-type.enum';
import { TaskDetails } from '../src/task/task.types';

describe('TaskController (e2e)', () => {
  let app: INestApplication;

  const taskFixture: TaskDetails = {
    id: '8cc3ee7d-06b1-4b35-a320-f5d94d3c9fe7',
    type: TaskType.PAYROLL,
    status: TaskStatus.ASSIGNED,
    payload: { batchId: 'payroll-1' },
    result: null,
    createdAt: new Date('2026-04-26T00:00:00.000Z'),
    updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    logs: [],
    transactions: [],
  };

  const orchestratorService = {
    handleTask: jest.fn().mockResolvedValue(taskFixture),
  };

  const taskService = {
    getTaskById: jest.fn().mockResolvedValue(taskFixture),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OrchestratorService)
      .useValue(orchestratorService)
      .overrideProvider(TaskService)
      .useValue(taskService)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    jest.clearAllMocks();
  });

  it('/tasks (POST)', () => {
    return request(app.getHttpServer())
      .post('/tasks')
      .send({
        type: TaskType.PAYROLL,
        payload: { batchId: 'payroll-1' },
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.id).toBe(taskFixture.id);
        expect(body.type).toBe(TaskType.PAYROLL);
        expect(body.status).toBe(TaskStatus.ASSIGNED);
      });
  });

  it('/tasks/:id (GET)', () => {
    return request(app.getHttpServer())
      .get(`/tasks/${taskFixture.id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.id).toBe(taskFixture.id);
        expect(body.type).toBe(TaskType.PAYROLL);
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
