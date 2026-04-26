import app from "./app.js";
import { env } from "./config/env.js";

app.listen(env.port, () => {
  console.log(`\n  ⚡ WizPay Backend running on http://localhost:${env.port}`);
  console.log(`     Environment : ${env.nodeEnv}`);
  console.log(`     CORS origins: ${env.corsOrigins.join(", ")}\n`);
});
