import { createApp } from "./app.ts";
import { AzurePlanner, CosmosStore, DemoKnowledge, DemoPlanner, ElasticKnowledge, MemoryStore } from "./adapters.ts";
import { readConfig } from "./config.ts";
import { Frontdesk } from "./frontdesk.ts";
import { CosmosReferralStore } from "./referral-store.ts";
import { ReferralFrontdesk } from "./referral-frontdesk.ts";
import { AzureReferralInterpreter } from "./referral-interpreter.ts";
import type { Config } from "./config.ts";
import type { VoiceHandler } from "./domain.ts";

async function initialize(config: Config): Promise<{ frontdesk: VoiceHandler; close(): Promise<void> }> {
  if (config.MODE === "referrals") {
    const interpreter = config.referrals.openai ? new AzureReferralInterpreter(config.referrals.openai) : undefined;
    const store = new CosmosReferralStore(config.referrals.COSMOS_ENDPOINT);
    try {
      await store.checkContainers();
    } catch (error) {
      store.close();
      throw error;
    }
    return { frontdesk: new ReferralFrontdesk(store, Date.now, interpreter), close: async () => store.close() };
  }
  const store = config.MODE === "cloud" ? new CosmosStore(config.cloud) : new MemoryStore();
  const knowledge = config.MODE === "cloud" ? new ElasticKnowledge(config.cloud) : new DemoKnowledge();
  return {
    frontdesk: new Frontdesk({
      store, knowledge,
      planner: config.MODE === "cloud" ? new AzurePlanner(config.cloud) : new DemoPlanner(),
      timeZone: config.HOSPITAL_TIME_ZONE,
    }),
    close: async () => {
      if (store instanceof CosmosStore) store.close();
      if (knowledge instanceof ElasticKnowledge) await knowledge.close();
    },
  };
}

const config = readConfig(process.env);
const services = await initialize(config);
const server = createApp(config, services.frontdesk).listen(config.PORT, () => {
  console.log(JSON.stringify({
    event: "listening", port: config.PORT, mode: config.MODE, syntheticDataOnly: true,
    referralAIEnabled: config.MODE === "referrals" && config.referrals.REFERRAL_AI_ENABLED,
  }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        console.error(JSON.stringify({ event: "shutdown_failed" }));
        process.exitCode = 1;
      }
      services.close().catch(() => {
        console.error(JSON.stringify({ event: "client_shutdown_failed" }));
        process.exitCode = 1;
      });
    });
  });
}
