import { createApp } from "./app.ts";
import { createServer } from "node:http";
import { ConversationRelay, RELAY_LIMITS } from "./conversation-relay.ts";
import { AzurePlanner, CosmosStore, DemoKnowledge, DemoPlanner, ElasticKnowledge, MemoryStore } from "./adapters.ts";
import { readConfig } from "./config.ts";
import { Frontdesk } from "./frontdesk.ts";
import { CosmosReferralStore } from "./referral-store.ts";
import { ReferralFrontdesk } from "./referral-frontdesk.ts";
import { AzureReferralInterpreter } from "./referral-interpreter.ts";
import { CallMonitor, cacheSlots, createMonitorRouter, type CallContext, type SlotsView } from "./monitor.ts";
import type { Config } from "./config.ts";
import type { VoiceHandler } from "./domain.ts";

type Services = {
  frontdesk: VoiceHandler;
  slots: SlotsView;
  contextOf?: (callId: string) => CallContext | null;
  close(): Promise<void>;
};

async function initialize(config: Config): Promise<Services> {
  if (config.MODE === "referrals") {
    const interpreter = config.referrals.openai ? new AzureReferralInterpreter(config.referrals.openai) : undefined;
    const store = new CosmosReferralStore(config.referrals.COSMOS_ENDPOINT);
    try {
      await store.checkContainers();
    } catch (error) {
      store.close();
      throw error;
    }
    let clinicNames: { at: number; names: Map<string, string> } | null = null;
    const slots: SlotsView = async () => {
      const now = Date.now();
      if (!clinicNames || now - clinicNames.at > 5 * 60_000) {
        const clinics = await store.listClinics();
        clinicNames = { at: now, names: new Map(clinics.map((clinic) => [clinic.id, clinic.name])) };
      }
      const names = clinicNames.names;
      return (await store.upcomingSlots(now)).map((slot) => ({
        id: slot.id, clinic: names.get(slot.clinic_id) ?? slot.clinic_id, clinicId: slot.clinic_id,
        service: slot.service,
        startsAt: slot.starts_at, endsAt: slot.ends_at, timeZone: slot.time_zone, status: slot.status,
      }));
    };
    const referralFrontdesk = new ReferralFrontdesk(store, Date.now, interpreter);
    return {
      frontdesk: referralFrontdesk, slots: cacheSlots(slots),
      contextOf: (callId) => referralFrontdesk.context(callId),
      close: async () => store.close(),
    };
  }
  const store = config.MODE === "cloud" ? new CosmosStore(config.cloud) : new MemoryStore();
  const knowledge = config.MODE === "cloud" ? new ElasticKnowledge(config.cloud) : new DemoKnowledge();
  const slots: SlotsView = async () => {
    const { state } = await store.load();
    const booked = new Set(state.appointments.map((appointment) => appointment.slotId));
    return state.slots.map((slot) => ({
      id: slot.id, clinic: slot.department, clinicId: slot.department, service: null,
      startsAt: slot.startsAt, endsAt: null,
      timeZone: config.HOSPITAL_TIME_ZONE, status: booked.has(slot.id) ? "booked" as const : "available" as const,
    }));
  };
  return {
    frontdesk: new Frontdesk({
      store, knowledge,
      planner: config.MODE === "cloud" ? new AzurePlanner(config.cloud) : new DemoPlanner(),
      timeZone: config.HOSPITAL_TIME_ZONE,
    }),
    slots,
    close: async () => {
      if (store instanceof CosmosStore) store.close();
      if (knowledge instanceof ElasticKnowledge) await knowledge.close();
    },
  };
}

const config = readConfig(process.env);
const services = await initialize(config);
const monitor = config.MONITOR_TOKEN ? new CallMonitor() : null;
const frontdesk = monitor ? monitor.wrap(services.frontdesk, services.contextOf) : services.frontdesk;
const monitorRouter = monitor ? createMonitorRouter(config.MONITOR_TOKEN, monitor, services.slots) : undefined;
const relay = config.VOICE_TRANSPORT === "relay"
  ? new ConversationRelay(config, frontdesk, undefined, monitor ? (callId, by) => monitor.endCall(callId, by) : undefined)
  : undefined;
const server = createServer(createApp(config, frontdesk, relay, monitorRouter));
relay?.attach(server);
server.listen(config.PORT, () => {
  console.log(JSON.stringify({
    event: "listening", port: config.PORT, mode: config.MODE, syntheticDataOnly: true,
    referralAIEnabled: config.MODE === "referrals" && config.referrals.REFERRAL_AI_ENABLED,
    voiceTransport: config.VOICE_TRANSPORT,
    monitorEnabled: Boolean(monitor),
    ...(relay ? { relayLimits: RELAY_LIMITS } : {}),
  }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    relay?.close();
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
