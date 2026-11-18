import { createApp } from "./app.ts";
import { AzurePlanner, CosmosStore, DemoKnowledge, DemoPlanner, ElasticKnowledge, MemoryStore } from "./adapters.ts";
import { readConfig } from "./config.ts";
import { Frontdesk } from "./frontdesk.ts";

const config = readConfig(process.env);
const store = config.MODE === "cloud" ? new CosmosStore(config.cloud) : new MemoryStore();
const knowledge = config.MODE === "cloud" ? new ElasticKnowledge(config.cloud) : new DemoKnowledge();
const frontdesk = new Frontdesk({
  store,
  knowledge,
  planner: config.MODE === "cloud" ? new AzurePlanner(config.cloud) : new DemoPlanner(),
  timeZone: config.HOSPITAL_TIME_ZONE,
});
const server = createApp(config, frontdesk).listen(config.PORT, () => {
  console.log(JSON.stringify({ event: "listening", port: config.PORT, mode: config.MODE, syntheticDataOnly: true }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(JSON.stringify({ event: "shutdown_failed" }));
        process.exitCode = 1;
      }
      if (store instanceof CosmosStore) store.close();
      if (knowledge instanceof ElasticKnowledge) {
        knowledge.close().catch(() => {
          console.error(JSON.stringify({ event: "search_client_shutdown_failed" }));
          process.exitCode = 1;
        });
      }
    });
  });
}
