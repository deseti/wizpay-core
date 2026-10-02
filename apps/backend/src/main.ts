import { Logger } from '@nestjs/common';
import { createWizPayApplication, type CreateApplication } from './application';

export {
  resolveCorsOrigins,
  WIZPAY_PRODUCTION_APP_ORIGIN,
} from './application';

export async function bootstrap(
  createApplication: CreateApplication | undefined = undefined,
  environment = process.env,
) {
  const app = await createWizPayApplication({
    createApplication,
    environment,
    runtimeMode: 'server',
  });
  app.enableShutdownHooks();
  const port = environment.PORT ?? 4000;
  await app.listen(port);
  new Logger('Bootstrap').log(`Application running on port ${port}`);
}

if (require.main === module) {
  void bootstrap();
}
