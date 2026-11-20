import express from "express";
import { timingSafeEqual } from "node:crypto";
import type { Reply, VoiceHandler } from "./domain.ts";
import { errorDetails, log } from "./logging.ts";

export const MONITOR_LIMITS = { maxCalls: 20, maxTurns: 60, maxTextLength: 600 } as const;

export type MonitorSlot = {
  id: string;
  clinic: string;
  clinicId: string;
  service: string | null;
  startsAt: string;
  endsAt: string | null;
  timeZone: string;
  status: "available" | "booked" | "blocked";
};
export type SlotsView = () => Promise<MonitorSlot[]>;
export type CallContext = { patient: string | null; clinicId: string | null; service: string | null };

// Dashboard polling must not translate 1:1 into dependency queries.
export function cacheSlots(view: SlotsView, ttlMs = 10_000, now: () => number = Date.now): SlotsView {
  let cached: { at: number; slots: MonitorSlot[] } | null = null;
  let pending: Promise<MonitorSlot[]> | null = null;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.slots;
    pending ??= view().then((slots) => {
      cached = { at: now(), slots };
      return slots;
    }).finally(() => { pending = null; });
    return pending;
  };
}

type MonitorTurn = {
  turn: number;
  at: string;
  caller: string | null;
  agent: string | null;
  failed: boolean;
};
export type MonitorCall = {
  callId: string;
  startedAt: string;
  updatedAt: string;
  status: "active" | "ended" | "transfer" | "failed";
  endedBy: "caller" | "agent" | "system" | null;
  context: CallContext | null;
  turns: MonitorTurn[];
};

function truncate(text: string): string {
  return text.length > MONITOR_LIMITS.maxTextLength ? `${text.slice(0, MONITOR_LIMITS.maxTextLength)}…` : text;
}

export class CallMonitor {
  private calls = new Map<string, MonitorCall>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  wrap(handler: VoiceHandler, contextOf?: (callId: string) => CallContext | null): VoiceHandler {
    return {
      handle: async (callId, turn, speech) => {
        try {
          const result = await handler.handle(callId, turn, speech);
          this.record(callId, result.turn, speech, result.reply, false, contextOf);
          return result;
        } catch (error) {
          // turn + 1 is this turn's would-be result turn; recording the request
          // turn would collide with and erase the previous successful entry.
          this.record(callId, turn + 1, speech, null, true, contextOf);
          throw error;
        }
      },
    };
  }

  snapshot(): MonitorCall[] {
    return [...this.calls.values()]
      .map((call) => ({
        ...call,
        context: call.context ? { ...call.context } : null,
        turns: call.turns.map((turn) => ({ ...turn })),
      }))
      .reverse();
  }

  // Transport-level end signal: who hung up, independent of the last reply.
  endCall(callId: string, by: "caller" | "agent" | "system"): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.updatedAt = new Date(this.now()).toISOString();
    call.endedBy = by;
    if (call.status === "active") call.status = "ended";
  }

  private record(
    callId: string, turn: number, speech: string, reply: Reply | null, failed: boolean,
    contextOf?: (callId: string) => CallContext | null,
  ): void {
    const at = new Date(this.now()).toISOString();
    const call = this.calls.get(callId)
      ?? { callId, startedAt: at, updatedAt: at, status: "active" as const, endedBy: null, context: null, turns: [] };
    // Reinsertion keeps the map ordered from least to most recently updated.
    this.calls.delete(callId);
    call.updatedAt = at;
    call.status = failed ? "failed" : reply?.transfer ? "transfer" : reply?.end ? "ended"
      : call.endedBy ? "ended" : "active";
    if (failed) call.endedBy = "system";
    else if (reply?.end || reply?.transfer) call.endedBy = "agent";
    call.context = contextOf?.(callId) ?? call.context;
    const entry: MonitorTurn = {
      turn, at,
      caller: speech.trim() ? truncate(speech.trim()) : null,
      agent: reply ? truncate(reply.message) : null,
      failed,
    };
    // Webhook/WS replays repeat a turn; overwrite instead of duplicating it.
    if (call.turns.at(-1)?.turn === turn) call.turns[call.turns.length - 1] = entry;
    else if (call.turns.length < MONITOR_LIMITS.maxTurns) call.turns.push(entry);
    this.calls.set(callId, call);
    while (this.calls.size > MONITOR_LIMITS.maxCalls) {
      const oldest = this.calls.keys().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
  }
}

export function createMonitorRouter(token: string, monitor: CallMonitor, slots: SlotsView): express.Router {
  const expected = Buffer.from(token);
  const router = express.Router();
  router.use((request, response, next) => {
    const header = request.get("authorization") ?? "";
    const provided = typeof request.query.token === "string" ? request.query.token
      : header.startsWith("Bearer ") ? header.slice(7) : "";
    const actual = Buffer.from(provided);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      log("warn", "monitor_request_rejected", { statusCode: 401 });
      response.sendStatus(401);
      return;
    }
    next();
  });
  router.get("/", (_request, response) => {
    response.type("html").send(PAGE);
  });
  router.get("/api/state", async (_request, response) => {
    const state = { generatedAt: new Date().toISOString(), syntheticDataOnly: true, calls: monitor.snapshot() };
    try {
      response.json({ ...state, slots: await slots() });
    } catch (error) {
      log("error", "monitor_slots_failed", { error: errorDetails(error) });
      response.json({ ...state, slots: null });
    }
  });
  return router;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Front Desk Monitor</title>
<style>
  :root {
    --bg: #0f1419; --panel: #171e26; --panel-2: #1d2733; --line: #2a3644;
    --text: #e6edf3; --muted: #8b9aab; --accent: #4da3ff; --green: #3fb97f;
    --amber: #e0a63f; --red: #e06060; --caller: #214a73; --agent: #232e3b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 18px; background: var(--panel); border-bottom: 1px solid var(--line); }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .banner { font-size: 11px; color: var(--amber); border: 1px solid var(--amber); border-radius: 4px; padding: 1px 8px; }
  #conn { margin-left: auto; font-size: 12px; color: var(--muted); }
  #conn.err { color: var(--red); }
  main { flex: 1; display: grid; grid-template-columns: 230px 1fr 340px; min-height: 0; }
  section { min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }
  section:last-child { border-right: none; }
  h2 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0; padding: 10px 14px 6px; }
  .scroll { overflow-y: auto; flex: 1; padding: 0 10px 12px; }
  .call { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; border: 1px solid transparent; }
  .call:hover { background: var(--panel-2); }
  .call.sel { background: var(--panel-2); border-color: var(--accent); }
  .call .id { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .call .patient { font-size: 12px; margin-top: 2px; }
  .call .meta { display: flex; justify-content: space-between; align-items: center; margin-top: 3px; font-size: 11px; color: var(--muted); }
  .filter-note { font-size: 11px; color: var(--muted); padding: 2px 14px 8px; }
  .filter-note a { color: var(--accent); cursor: pointer; text-decoration: underline; }
  .chip { font-size: 10px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
  .chip.active { background: #15351f; color: var(--green); }
  .chip.ended { background: #2a3240; color: var(--muted); }
  .chip.transfer { background: #3a3012; color: var(--amber); }
  .chip.failed { background: #3a1818; color: var(--red); }
  .chip.available { background: #15351f; color: var(--green); }
  .chip.booked { background: #182b45; color: var(--accent); }
  .chip.blocked { background: #3a1818; color: var(--red); }
  .bubble { max-width: 82%; margin: 6px 0; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
  .bubble .who { font-size: 10px; color: var(--muted); margin-bottom: 2px; text-transform: uppercase; letter-spacing: .05em; }
  .bubble.caller { background: var(--caller); margin-left: auto; border-bottom-right-radius: 3px; }
  .bubble.agent { background: var(--agent); margin-right: auto; border-bottom-left-radius: 3px; }
  .bubble.failed { border: 1px solid var(--red); }
  .endnote { text-align: center; color: var(--muted); font-size: 11px; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .06em; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px; position: sticky; top: 0; background: var(--bg); }
  td { padding: 5px 8px; border-top: 1px solid var(--line); vertical-align: top; }
  .empty { color: var(--muted); padding: 18px 14px; font-size: 13px; }
  .clinic { color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>Front Desk Monitor</h1>
  <span class="banner">SYNTHETIC DEMO DATA ONLY</span>
  <span id="conn">connecting…</span>
</header>
<main>
  <section><h2>Calls</h2><div id="calls" class="scroll"></div></section>
  <section><h2>Transcript</h2><div id="transcript" class="scroll"></div></section>
  <section><h2>Appointment Slots</h2><div id="slot-filter" class="filter-note"></div><div id="slots" class="scroll"></div></section>
</main>
<script>
(() => {
  "use strict";
  const token = new URLSearchParams(location.search).get("token") ?? "";
  let selected = null;
  let showAllSlots = false;
  let data = { calls: [], slots: [] };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const slotFmt = (iso, tz) => new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
  const endLabel = (call) => call.endedBy === "caller" ? "caller hung up"
    : call.endedBy === "agent" ? (call.status === "transfer" ? "transferred to staff" : "agent ended call")
    : call.endedBy === "system" ? "ended by system" : null;

  function renderCalls() {
    const box = document.getElementById("calls");
    box.replaceChildren();
    if (!data.calls.length) { box.append(el("div", "empty", "No calls yet.")); return; }
    for (const call of data.calls) {
      const item = el("div", "call" + (call.callId === selected ? " sel" : ""));
      item.append(el("div", "id", call.callId));
      if (call.context && call.context.patient) item.append(el("div", "patient", call.context.patient));
      const meta = el("div", "meta");
      meta.append(el("span", null, timeFmt.format(new Date(call.updatedAt))),
        el("span", "chip " + call.status, endLabel(call) ?? call.status));
      item.append(meta);
      item.onclick = () => { selected = call.callId; showAllSlots = false; render(); };
      box.append(item);
    }
  }

  function renderTranscript() {
    const box = document.getElementById("transcript");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.replaceChildren();
    const call = data.calls.find((entry) => entry.callId === selected);
    if (!call) { box.append(el("div", "empty", "Select a call to view its transcript.")); return; }
    for (const turn of call.turns) {
      if (turn.caller !== null) {
        const bubble = el("div", "bubble caller");
        bubble.append(el("div", "who", "Caller · " + timeFmt.format(new Date(turn.at))), el("div", null, turn.caller));
        box.append(bubble);
      }
      const bubble = el("div", "bubble agent" + (turn.failed ? " failed" : ""));
      bubble.append(
        el("div", "who", "Agent · turn " + turn.turn),
        el("div", null, turn.failed ? "⚠ request failed — terminal voice reply played" : turn.agent),
      );
      box.append(bubble);
    }
    const ended = endLabel(call);
    if (ended) box.append(el("div", "endnote", "— " + ended + " —"));
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function renderSlots() {
    const box = document.getElementById("slots");
    const note = document.getElementById("slot-filter");
    box.replaceChildren();
    note.replaceChildren();
    if (data.slots === null) { box.append(el("div", "empty", "Slot lookup failed — check server logs.")); return; }
    const call = data.calls.find((entry) => entry.callId === selected);
    const context = call && call.context && call.context.clinicId ? call.context : null;
    let slots = data.slots;
    if (context && !showAllSlots) {
      slots = slots.filter((slot) => slot.clinicId === context.clinicId
        && (context.service === null || slot.service === context.service));
      const label = (context.patient ? context.patient + " — " : "")
        + (context.service ? context.service.replaceAll("_", " ") : "selected referral");
      const toggle = el("a", null, "show all");
      toggle.onclick = () => { showAllSlots = true; render(); };
      note.append(el("span", null, "Filtered for " + label + " · "), toggle);
    } else if (context && showAllSlots) {
      const toggle = el("a", null, "filter for " + (context.patient ?? "selected call"));
      toggle.onclick = () => { showAllSlots = false; render(); };
      note.append(el("span", null, "Showing all slots · "), toggle);
    }
    if (!slots.length) { box.append(el("div", "empty", context && !showAllSlots ? "No upcoming slots for this referral." : "No upcoming slots.")); return; }
    const table = el("table");
    const head = el("tr");
    for (const column of ["Time", "Service", "Status"]) head.append(el("th", null, column));
    table.append(head);
    for (const slot of slots) {
      const row = el("tr");
      const when = el("td");
      when.append(el("div", null, slotFmt(slot.startsAt, slot.timeZone)), el("div", "clinic", slot.clinic));
      row.append(when);
      row.append(el("td", null, slot.service ? slot.service.replaceAll("_", " ") : "—"));
      const status = el("td");
      status.append(el("span", "chip " + slot.status, slot.status));
      row.append(status);
      table.append(row);
    }
    box.append(table);
  }

  function render() { renderCalls(); renderTranscript(); renderSlots(); }

  async function refresh() {
    const conn = document.getElementById("conn");
    try {
      const response = await fetch("/monitor/api/state", { headers: { authorization: "Bearer " + token } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      data = await response.json();
      if (selected === null && data.calls.length) selected = data.calls[0].callId;
      conn.textContent = "updated " + timeFmt.format(new Date());
      conn.className = "";
      render();
    } catch {
      conn.textContent = "disconnected — retrying";
      conn.className = "err";
    }
  }

  refresh();
  setInterval(refresh, 2500);
})();
</script>
</body>
</html>`;
