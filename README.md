# Agentic front desk

Initial **synthetic-data-only** hospital voice agent. No real appointments or
patient identities are supported. The default demo shares one fictional patient
and schedule; referral mode reads seeded fictional patients and clinics.
Do not route a real hospital number here or enter patient information.

## Architecture

```text
Caller -> Twilio Voice (speech recognition + text-to-speech)
       -> signed POST /voice -> front-desk orchestrator
                               |-> Azure OpenAI: structured tool-call intent
                               |-> Elasticsearch: approved hospital FAQ passages
                               |-> Cosmos DB: demo schedule + call state
       <- TwiML Gather / Say / Dial
```

The model proposes actions; server code validates slots and appointments.
Booking/rescheduling requires a separate, explicit spoken confirmation.
Appointment changes and call progress commit atomically using a Cosmos ETag.
Duplicate/stale Twilio turns replay the latest response without repeating writes.
FAQ responses quote a retrieved passage and speak its source title; the model
cannot generate hospital facts. Retrieval currently uses Elasticsearch keyword
search, not embeddings or vector search. Ambiguous/unsupported requests go to
staff. Without a configured staff number, callers are told no transfer occurred.

## Local setup

Requires Node.js 24+ and npm.

```sh
npm ci
cp .env.example .env
```

Configure `.env` and start the app using the tunnel instructions below.

`MODE=demo` uses in-memory storage, synthetic FAQs, and a deterministic planner.
It makes no Azure, Elasticsearch, or LLM calls. Data resets on restart.
Try “availability”, “book slot-2”, “yes”, “reschedule appointment-demo to slot-3”,
“hours”, “parking”, and “staff”. The demo planner accepts “slot two” or “slot 2”;
cloud mode lets the model interpret natural-language dates and times.
All spoken times use `HOSPITAL_TIME_ZONE`.

### Public base URL for local development and demos

Twilio needs a public HTTPS URL to reach your local app; it cannot reach
`localhost` directly. A Cloudflare Quick Tunnel provides a temporary URL without
requiring a Cloudflare account or your own domain.

1. Install Cloudflare Tunnel on macOS with Homebrew:

   ```sh
   brew install cloudflared
   ```

2. Start a tunnel to the app's local port:

   ```sh
   cloudflared tunnel --url http://localhost:3000
   ```

   Keep this terminal running. Copy the HTTPS URL printed by the command,
   for example `https://random-words.trycloudflare.com`. If you change `PORT`
   in `.env`, use that same port in the tunnel command.

3. Set these values in `.env`:

   ```dotenv
   MODE=demo
   PUBLIC_BASE_URL=https://random-words.trycloudflare.com
   TWILIO_AUTH_TOKEN=your-twilio-account-auth-token
   ```

   Replace the example URL with your actual tunnel URL. Use only the origin:
   do not append `/voice` or a query string. Use your Twilio **account auth
   token**, not an API key. Never commit `.env` or share the token.
   `MODE=demo` keeps this walkthrough synthetic and local; use `MODE=cloud`
   only after completing the cloud-backed demo setup below.

4. In a separate terminal, start the app:

   ```sh
   npm run dev
   ```

   Check the public URL, replacing the example hostname:

   ```sh
   curl https://random-words.trycloudflare.com/healthz
   ```

   Expect `{"status":"ok","mode":"demo","syntheticDataOnly":true,"voiceTransport":"gather"}`.

5. In **Twilio Console → Phone Numbers → Manage → Active numbers**, select
   your Voice-capable number. Under **Voice configuration**, set
   **A call comes in** to **Webhook**, enter
   `https://random-words.trycloudflare.com/voice`, choose **HTTP POST**, and save.
   **Configure the Voice webhook, not the Messaging webhook.**

6. Call the Twilio number and try the synthetic appointment workflow.

For a live demo, leave both the app and tunnel running and keep your computer
awake with a working internet connection. Test a call before presenting.
Quick Tunnel URLs change when the tunnel restarts: update `PUBLIC_BASE_URL`
and the Twilio Voice webhook, then restart the app to reload `.env`.
Stop the tunnel when finished to remove public access.

For a repeatable demo with a stable URL, use a named Cloudflare Tunnel with a
domain you control, or deploy the app behind a stable HTTPS endpoint. Set
`PUBLIC_BASE_URL` and the Twilio Voice webhook to that hostname in the same way.
The tunnel is only transport; it does not make the app suitable for real patient
data.

Signatures are checked against the configured public URL, including query
parameters; the application does not trust forwarded host headers.
No call recording is enabled by this application.

`GET /healthz` is an unauthenticated liveness check only. It does not establish
cloud dependency readiness. All voice routes require a valid Twilio signature.

## Cloud-backed demo

Set `MODE=cloud` and fill all cloud variables in `.env`.
Use dedicated demo resources; the service does not provision infrastructure.

1. **Cosmos DB for NoSQL:** create the configured database and container with
   partition key **`/id`**. The first call creates the `synthetic-frontdesk`
   document containing fictional appointments, slots, and call state.
   The single-document aggregate is deliberate for atomic demo scheduling, not
   a production patient/appointment schema.
2. **Elasticsearch:** create the configured index using this mapping:

   ```json
   {
     "mappings": {
       "properties": {
         "title": { "type": "text" },
         "answer": { "type": "text" },
         "approved": { "type": "boolean" }
       }
     }
   }
   ```

   Index synthetic FAQ documents, for example:

   ```json
   {
     "title": "Synthetic clinic hours",
     "answer": "The fictional demo clinic is open weekdays from 9 AM to 5 PM.",
     "approved": true
   }
   ```

   Use document ID `hours`. Titles must be at most 200 characters and answers at
   most 1,200. Only `approved: true` documents are retrieved. Keep this dedicated
   index free of patient data, secrets, and unreviewed content.
3. **Azure OpenAI:** supply an endpoint, key, API version, and deployment of a
   model supporting strict function tools. For example, use a compatible
   GPT-4.1 deployment. Azure availability and API support depend on your region.
4. Optionally set `STAFF_PHONE_NUMBER` to an authorized, staffed E.164 number.
   Twilio trial accounts may require the destination to be verified.

Slots are seeded for the next three days relative to initial creation, not
refreshed automatically. To reset an expired cloud demo, stop all instances and
delete only the `synthetic-frontdesk` document from the demo container.
Never do this against real scheduling data.

```sh
npm test
npm run typecheck
npm run build
npm start
```

## Seed referral demo data into Cosmos DB

The standalone TypeScript seeder targets the existing `hospital-network-db`
database in `cosmos-db-resource`, with `clinics` and `patients` containers.
Both containers must already exist with partition key **`/id`**. The script
does not create infrastructure, delete documents, or use Cosmos keys.

**Prerequisites:** Node.js 24+, `npm ci`, the Azure CLI, and an Azure identity
with the **Cosmos DB Built-in Data Contributor** data-plane role on the target
database or account. Azure subscription/resource Contributor access alone does
not grant Cosmos document access.

An administrator with permission to manage Cosmos SQL role assignments can
grant the role to your signed-in user, substituting the account's resource group:

```sh
az login
az cosmosdb sql role assignment create \
  --account-name cosmos-db-resource \
  --resource-group "<resource-group>" \
  --scope "/dbs/hospital-network-db" \
  --principal-id "$(az ad signed-in-user show --query id --output tsv)" \
  --role-definition-id "00000000-0000-0000-0000-000000000002"
```

Allow time for a new role assignment to propagate. If the account restricts
network access, allow your development machine's public IP or use its approved
private network.

The seeder uses `DefaultAzureCredential` from `@azure/identity`, which can use
your Azure CLI login locally or a managed identity when hosted in Azure.
Other configured credentials in its credential chain may take precedence over
your CLI identity. No credentials or connection strings belong in source code.

```sh
az login
export COSMOS_ENDPOINT="https://cosmos-db-resource.documents.azure.com:443/"

# Generate and validate locally, without Azure authentication or writes:
npm run seed:demo -- --seed=42 --dry-run

# Validate, then upsert into the existing Cosmos containers:
npm run seed:demo -- --seed=42
```

`COSMOS_ENDPOINT` is the only required environment variable for ingestion.
The seeder reads the shell environment, **not `.env`**, and does not depend on
`MODE`, Elasticsearch, Azure OpenAI, or the voice server. Database and container
names are shared constants in `src/referral-models.ts`.

The dataset includes:

- 10 clearly labeled fictional NYC-area clinics, with differing services/hours.
- 100 synthetic adult patients with 125 referrals: 80 patients have one referral,
  15 have two, and five have three. Multiple referrals use distinct source hospitals.
- All seven referral workflow states, biased toward active work, with consistent
  scheduling/contact timestamps and supported clinic/service relationships.
- English, Spanish, Chinese, and Russian language preferences; SMS/voice contact
  preferences; reserved fictional `555-0100` through `555-0199` phone numbers;
  and `example.com` emails. Names, addresses, providers, reasons, and identifiers
  are generated demo fixtures, not real patient information.
- An `is_demo: true` flag and `demo_dataset: "hospital-referrals-demo-v1"` marker
  on every clinic/patient document. Patient first names are generated without
  a `Demo ` prefix; these markers identify the data as fictional instead.

**Deterministic dates:** the default reference time is fixed at
`2026-11-18T12:00:00.000Z`, so the same seed produces the same dataset on reruns.
“Future” and “past” appointments are relative to that reference time.
For a later presentation, explicitly set a current reference time and reuse it
for repeatable reruns:

```sh
npm run seed:demo -- --seed=42 --as-of=2026-12-01T12:00:00Z
```

All data is validated before any document is uploaded. Both container partition
keys are checked before the first write. Clinics upload first, then patients,
and the script prints referral counts by status.

**Safe reruns:** readable IDs stay fixed (`clinic_001`–`clinic_010`,
`patient_001`–`patient_100`, and globally unique nested referral IDs).
Upserts replace documents with those IDs, including any edits made to them;
other document IDs are untouched. Use dedicated demo containers and do not
reuse these IDs for non-demo records. Changing the seed/reference time updates
the same demo records instead of appending duplicates. Uploads are not a
cross-container transaction: if one fails, the script exits unsuccessfully and
may leave partial progress. Fix the issue and rerun with the same arguments.
There is deliberately no reset/delete option.

This referral dataset is separate from the original voice demo's
`synthetic-frontdesk` aggregate. Enable referral mode below to read the seeded
patients and clinics over Twilio.

## Referral availability and confirmed demo booking

This mode uses Cosmos DB and the existing Twilio voice interface.
It works **without Azure OpenAI or Elasticsearch** by default. Optionally enable
Azure OpenAI below for natural-language interpretation; Elasticsearch is still
not required.

### 1. Add the availability container

In Azure Portal, open your Cosmos account's **Data Explorer**, select
`hospital-network-db`, and create a container with these exact settings:

| Container | Partition key | Purpose |
|---|---|---|
| `clinics` (existing) | `/id` | Seeded fictional clinic details and hours |
| `patients` (existing) | `/id` | Seeded fictional patients and referrals |
| `appointment_slots` (new) | **`/clinic_id`** | Synthetic clinic/service availability |

Do not recreate or rename `clinics` or `patients`. Review the throughput/cost
settings before creating the new container. The application and seeder do not
create containers. The database-scoped Cosmos data-plane role documented above
covers the new container.

### 2. Generate synthetic slots from the existing clinics

```sh
az login
export COSMOS_ENDPOINT="https://cosmos-db-resource.documents.azure.com:443/"

# Reads actual demo clinics and checks container partition keys; no writes:
npm run seed:availability -- --dry-run

# Inserts missing demo availability:
npm run seed:availability
```

Unlike the patient seeder, this command also loads `.env` if present; exported
environment variables take precedence. It generates 30-minute slots for each
supported service during each clinic's listed hours, for the next 14 calendar
days starting tomorrow in `America/New_York`. Closed days are skipped and
daylight-saving changes are handled in that time zone. You can set `--days=7`
(1–30) or `--as-of=2026-11-18T12:00:00Z` for a reproducible date window.

Slots have stable IDs, UTC `starts_at`/`ends_at`, `clinic_id`, `service`,
`time_zone`, `status`, and demo markers. Each clinic/service has independent
simulated capacity; this is not a provider calendar or real booking system.
Creating several thousand slots consumes Cosmos request units and can take
time. Reruns preserve existing slots, including any `booked`/`blocked` status,
instead of reopening them. Old slots are not deleted; availability queries
exclude past starts. Rerun the seeder to extend the future window before demos.
An interrupted run may leave partial inserts and can be safely rerun.

### 3. Enable referral mode and call

In `.env`, set:

```dotenv
MODE=referrals
COSMOS_ENDPOINT=https://cosmos-db-resource.documents.azure.com:443/
```

Keep the existing `TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL`, and tunnel setup.
No Cosmos key, Azure OpenAI configuration, or Elasticsearch configuration is
required in this mode. Restart the app:

```sh
npm run dev
```

Startup verifies all three containers and their partition keys. Call the Twilio
number and say **"patient one"** (or `patient_001`). The handler accepts demo
patient numbers 1–100 or a seeded fictional patient's **first and last name**.
You can say the name directly or **"my name is [fictional first and last name]"**.
Find test names in the `patients` container's `first_name` and `last_name` fields.
Older records may still have a `Demo ` prefix; it is optional when speaking.
Never provide a real person's name or date of birth.

Full-name lookup is case-insensitive and normalizes spoken whitespace and curly
apostrophes. It requires the complete first and last name, not a first name,
partial match, or fuzzy spelling. If no record matches, try the fictional name
again or use the demo patient number. If multiple records match, no patient is
selected and the caller must use a demo patient number; the app does not read
candidate names, dates of birth, or contact details. Patient-number lookup
continues to work as before.

- After a unique patient match, the bot welcomes the caller by the stored first
  name before presenting referral details. A legacy `Demo ` prefix is omitted
  from the welcome. Unmatched or ambiguous lookups do not receive a named welcome.
- If the patient has one active referral, it reads the next three available
  slots for that destination clinic and service.
- With multiple active referrals, say **"referral one"** or **"referral two"**
  after hearing the choices.
- Active states are `pending_contact`, `contacted`, `scheduling`, and
  `unable_to_reach`. Already scheduled, declined, or completed referrals are
  excluded. A patient may have no active referrals; try another demo number.
- Say **"availability"** to refresh, another patient number or fictional full
  name to switch patients, or **"staff"** to use the configured handoff.
- Say **"book option one"**, **"book option two"**, or **"option three"** using
  an offered choice. The bot repeats the service, clinic, date, time, and duration.
  Nothing is reserved until a separate confirmation. **"Yes"** or **"confirm"**
  always works; with referral AI enabled, a clear natural-language approval such
  as **"yes, that time works for me"** works too.
- Before confirmation, **"no"** discards the proposal without writing anything.
  Decline first if you want to switch patients or referrals.
- On confirmation, the app conditionally claims the slot in `appointment_slots`
  and updates the selected patient's referral to `scheduled`, with its appointment
  time and scheduling status. Booked slots disappear from subsequent availability.
  If another caller took the slot or it expired, say **"availability"** to refresh.
- After a successful booking, the bot asks **"Is there anything else I can help
  you with?"** Say **"no"**, **"no thank you"**, or **"that's all"** for a friendly
  goodbye and hangup. Say **"yes"** to continue with another referral lookup, or
  give the next fictional patient name/number directly. These follow-up yes/no
  answers do not trigger another booking or model request.
- Rescheduling and cancellation of an existing appointment are not implemented.
  Before confirmation, **"no"** discards the unsubmitted proposal; after booking,
  it declines further help. Neither response cancels a booked appointment.

The voice service and seeders require **Cosmos DB Built-in Data Contributor**
data-plane access to this database, using `DefaultAzureCredential` as above.
No new containers or migration scripts are needed to enable booking.
Only documents matching the demo
schemas/markers are accepted. **Full-name matching is not identity verification.**
There is no patient authentication, so never use this mode with real patient
data. Call state is process-local, expires after
30 minutes of inactivity on the next request, and resets on restart. Use a single
app instance for this demo; multiple instances would need shared call state.
The same 100-active-call and 20-turn demo limits apply.

### Booking safeguards and interrupted requests

Conditional ETag patches prevent two callers from claiming the same slot and
prevent one referral from being booked into two different slots. The bot reports
success only after both the slot and referral updates succeed. Replayed voice
turns and retries reuse the same booking ID, rather than making another appointment.

Cosmos cannot transact across these containers/partitions. After explicit
confirmation, the app saves a durable intent in `referrals[].scheduling.booking`,
claims the slot with matching ownership metadata, then marks the referral scheduled
and the intent confirmed. It patches individual fields, preserving other patient
fields and referrals.

If a write's outcome is unknown, the app gives the existing uncertainty/handoff
message; it does not claim failure, success, or cancellation. A retry or a later
call selecting the same active referral resumes the already-confirmed intent.
This recovery can complete the original booking without asking for confirmation
again. It never creates a different booking. There is no background recovery
worker; use staff assistance if the operation keeps failing. Expired, unclaimed
slots with pending intents are conditionally blocked before releasing the intent,
so a delayed duplicate request cannot claim them afterward.

**Do not rerun `seed:demo` or manually reset patient/slot records while testing
bookings.** Patient upserts overwrite referral/booking state. The create-only
`seed:availability` command preserves existing booked and blocked slots.
All these appointments remain fictional and are not sent to any hospital/EHR.

### Optional Azure OpenAI natural-language routing

Use an Azure OpenAI resource with a Chat Completions deployment supporting strict
function tools, such as `gpt-4.1-mini`. Deploy it in your chosen region using a
pay-as-you-go SKU rather than provisioned throughput. Model availability and
quota vary by subscription. This integration does not need a Foundry project,
Elasticsearch, another Cosmos container, or an API key.

Grant your signed-in developer identity **Cognitive Services OpenAI User** on
the OpenAI resource (this is separate from Cosmos data access):

```sh
az login
az role assignment create \
  --assignee-object-id "$(az ad signed-in-user show --query id --output tsv)" \
  --assignee-principal-type User \
  --role "Cognitive Services OpenAI User" \
  --scope "$(az cognitiveservices account show \
    --resource-group YOUR_RESOURCE_GROUP --name YOUR_OPENAI_RESOURCE \
    --query id --output tsv)"
```

In `.env`, keep `MODE=referrals` and set:

```dotenv
REFERRAL_AI_ENABLED=true
AZURE_OPENAI_ENDPOINT=https://YOUR_OPENAI_RESOURCE.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=YOUR_DEPLOYMENT_NAME
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_API_KEY=
```

The deployment name is not necessarily the model name. Keep the API key blank;
referral mode uses `DefaultAzureCredential` and Entra tokens. Restart the app
with `npm run dev`; the listening log reports `referralAIEnabled: true`.
Role assignments can take time to propagate. Set `REFERRAL_AI_ENABLED=false`
to return to the original exact-command flow without removing Azure settings.

After identifying a fictional patient and choosing a referral, try:

- **"Anything Thursday afternoon?"**
- **"Show me morning appointments."**
- **"The second appointment works for me."**

Date searches cover today through the next 30 days, subject to seeded inventory.
Morning means starts before noon, afternoon noon–5 PM, and evening 5 PM onward,
all in `America/New_York`. The app applies these filters in Cosmos **before**
choosing the next three slots, including across daylight-saving transitions.
Say **"availability"** to refresh the current search or **"show any time"** to
remove date/time preferences. Exact time cutoffs, date ranges, and clinic changes
are not supported in this first interpreter; use a date and a day period instead.

The model returns one validated intent, not spoken medical advice or a booking
result. It cannot supply document IDs, write Cosmos, or bypass offered choices.
Selecting a time only proposes it. Simple **"yes"** / **"confirm"** and **"no"**
responses are handled locally. With referral AI enabled, other responses are
classified against the single pending appointment: **"sounds good, please book
it"** can approve it, while **"please don't book that"** discards an unsubmitted
proposal. Questions, uncertainty, conditional approvals, and requests to change
the time repeat the confirmation without making changes. Confirmation cannot
select a different slot or act without a pending proposal. A rejection after an
uncertain write cannot undo or claim to undo that write. Existing booking
ownership, replay, and recovery protections remain in application code.
Conditional/uncertainty markers such as **"if"**, **"yes, but"**, and **"maybe"**
trigger a local clarification rather than asking the model for approval.

Only the current utterance, local date/time zone, selection-state flags/counts,
offered option numbers/times, and the pending appointment's time/submission flag
go to Azure OpenAI. Patient documents, contact
details, referral reasons, credentials, and raw call identifiers are not sent.
An utterance can itself contain a fictional name: never use real patient data.
Model errors/refusals/timeouts use the existing uncertainty/handoff path;
there is no silent model-error fallback or model-generated success claim.
Exact commands and simple yes/no confirmations do not need a model request;
natural-language confirmations use the same bounded Azure interpreter.

**Cost controls:** each model request allows at most 256 output tokens, has a
five-second timeout, and disables SDK retries. Both Azure adapters share a local
development guard: **100 model requests per running process**, **10 requests per
rolling minute**, and **one in-flight model request**. Failed requests consume
the allowance too. Excess requests are rejected before reaching Azure, with no
queue or automatic retry; voice callers hear an explicit AI-limit/busy message
and are offered the configured staff handoff. Exact commands that do not need AI
can still work.

The 100-request allowance does not refill with time; restarting the app resets
it. Separate app processes/workers each have their own allowance. This is not a
durable wallet, subscription-wide safeguard, or a token/dollar spending cap.
It does not limit Cosmos, Twilio, calls from other applications, or creation of
expensive Azure resources. Use Azure Policy/RBAC and service quotas separately
to restrict provisioning, and configure deployment token/rate limits too.
In Azure Portal, use **Cost Management → Budgets → Add**, filter to your OpenAI
resource, and set a $20 budget with alerts at 50%, 80%, and 100%.
[Azure budgets](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
do not stop requests, reset periodically, and use delayed cost data (typically
8–24 hours). They are not a prepaid "$20 until refilled" balance. No automatic
spending cutoff or application budget wallet is implemented.

### Real-time voice with ElevenLabs

The optional `relay` transport uses Twilio ConversationRelay for real-time speech
recognition, ElevenLabs for a warm female US-English voice, and the same front-desk
handler and Azure intent interpreter as before. No new Azure audio model or
ElevenLabs API key is required. Twilio bills ConversationRelay/voice separately
from Azure model tokens; check your account's rates before testing.

1. In Twilio Console, open **Voice → Settings → Privacy & Security** (or
   **Settings → General** in the legacy console). Read and accept the
   **Predictive and Generative AI/ML Features Addendum**, then save. This legal
   acceptance must be completed by the account owner, not by this app.
2. Keep the existing phone-number **POST** webhook pointing to
   `https://your-public-host/voice`. Your HTTPS tunnel must also support WebSocket
   upgrades; Cloudflare Tunnel does. The app derives its `wss://` URL from
   `PUBLIC_BASE_URL`; no second port is needed.
3. Set these values in `.env`, keeping your existing referral/Azure settings:

   ```dotenv
   VOICE_TRANSPORT=relay
   ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
   ```

   The default is Rachel, using ElevenLabs v4. You can substitute an available
   20-character voice ID from the
   [Twilio voice picker](https://www.twilio.com/docs/voice/conversationrelay/voice-configuration).
   Do not include an `ElevenLabs.` prefix or model suffix in the environment value.
4. Restart `npm run dev`. `/healthz` should report `"voiceTransport":"relay"`.
   Call the existing Twilio number to test the voice; neither the phone webhook
   nor the Azure deployment needs changing.

**Hard development limits:**

- **One active real-time session per app process**, reserved before issuing
  `<Connect>`. Additional calls receive a busy rejection, rather than
  starting another paid ConversationRelay session.
- **Five minutes per call.** The app sets Twilio's call `timeLimit` to 300 seconds
  before running the front-desk handler, and independently ends the relay at five
  minutes from admission. If setting the Twilio limit fails, the session ends
  without starting the handler. Twilio's limit remains in effect if the server
  stalls or crashes. A setup that doesn't complete within 15 seconds also ends.
- No automatic reconnect, unbounded message queue, or automatic model retry.
  Incoming messages are capped at 8 KB each and 100 per session; only final
  transcriptions of up to 2,000 characters reach the handler.
- Existing **100 model requests per process / 10 per minute / one in flight**
  guards still apply. Interruptions stop speech playback, not booking writes.
  Speech received while a request is being checked is explicitly rejected with
  a repeat-after-response prompt, never queued into a later confirmation.
- All app speech, including hardcoded replies, goodbyes, handler errors, and
  staff-transfer announcements, uses the configured ElevenLabs voice. Final
  speech cannot be interrupted. The app waits for `tokensPlayed` events matching
  the entire final utterance before ending/transferring, not merely an event
  saying earlier speech stopped. This wait is capped at 30 seconds and never
  extends the original five-minute deadline; missing confirmation aborts the
  transfer, logs a failure, and ends the session.
- There is **no fallback to another voice**. Admission rejects use a busy tone;
  connection/provider failures end without an alternate spoken announcement.
  When no staff number is configured, that explanation is spoken in ElevenLabs
  before hanging up. After a staff dial attempt, the call hangs up without
  another announcement; unsuccessful attempts are logged. Staff dial attempts
  remain bounded to five minutes.

These are **process-local/per-call limits, not a spending wallet**. Restarting
or running more app processes allows more calls; repeated short calls still incur
telephony charges. The limits don't prevent costly Azure provisioning. Set
`VOICE_TRANSPORT=gather` and restart to restore the original voice flow. Relay
failures are logged and end the session; they never silently restart the
conversation or claim an uncertain booking failed or succeeded.

Only use synthetic data. Relay speech/text passes through Twilio, ElevenLabs and
the configured transcription provider (Deepgram). Recordings and conversation
intelligence aren't enabled by this implementation. Do not send real patient
information without a separate compliance and vendor-agreement review.

References: [Twilio onboarding](https://www.twilio.com/docs/voice/conversationrelay/onboarding),
[WebSocket protocol](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages).

### Terminal diagnostics

Restart `npm run dev` after code changes; it does not automatically reload.
Voice requests now print structured JSON logs to the app terminal:

- `voice_request_started` / `voice_request_completed`: mode, generated request
  ID, HTTP status, and elapsed milliseconds. The ID is also returned in the
  `x-request-id` response header.
- `voice_turn_received`: turn number and whether speech was provided, **not**
  the speech text.
- `dependency_operation_started` / `dependency_operation_completed` /
  `dependency_operation_failed`: the specific referral Cosmos operation
  (`cosmos.patient.read`, `cosmos.patient.name_query`, `cosmos.clinic.read`,
  `cosmos.slots.query`, `cosmos.referral.book`, `cosmos.booking.*`, or
  `azure_openai.referrals.interpret`), duration,
  and safe error details. Container checks are logged at startup as well.
- `voice_request_failed`: sanitized error type, Cosmos HTTP/substatus codes and
  activity ID when available, troubleshooting hints, or schema issue field
  paths/codes. Raw error messages, stacks, documents, and validation values are
  deliberately excluded.
- `voice_request_rejected`: signature failures (403) or malformed payloads (400).
  Check `PUBLIC_BASE_URL`, the current tunnel URL, and `TWILIO_AUTH_TOKEN` if
  signature validation fails.
- `llm_request_blocked`: the local `process`, `rate`, or `concurrency` guard
  rejected a model request, including requests used/remaining for this process.
  No transcript or patient details are logged.
- `relay_session_started` / `relay_session_ended` / `relay_session_failed`:
  real-time voice lifecycle with safe reasons/errors. `relay_call_rejected`
  identifies rejected admission/handshakes; `relay_input_rejected` identifies
  overlapping speech that must be repeated. No caller identifiers, transcripts,
  ticket URLs, or provider error messages are logged.
- `voice_request_slow`: no response after 8 seconds; this is a warning, not a
  change to request timeouts. `voice_request_aborted` means the connection closed
  before a response finished.

Logs sharing a request ID belong to the same webhook request. If Twilio says
"an application error has occurred" but no request-start log appears, check the
tunnel and Twilio **Monitor → Logs → Calls** error details. If a request starts
but stalls, the last dependency-start log identifies the operation to investigate.
HTTP 200 on the final error response means the app returned a spoken error/handoff
message, **not** that the requested operation succeeded.

## Front desk observability UI

Set `MONITOR_TOKEN` (at least 16 characters) to enable a read-only dashboard at
`PUBLIC_BASE_URL/monitor?token=<MONITOR_TOKEN>`:

- **Call transcripts** as a chat log: caller speech and agent replies per turn,
  with per-call status (`active`, `ended`, `transfer`, or `failed`) and, once a
  session ends, who ended it — `caller hung up` (WebSocket closed mid-call),
  `agent ended call`/`transferred to staff` (terminal reply), or `ended by
  system` (duration limit, setup/playback timeout, or provider error). Transcripts
  are captured in memory by wrapping the voice handler, so they work with both
  the `gather` and `relay` transports and are lost on restart. Memory is bounded
  (20 most recent calls, 60 turns per call, truncated text).
- **Appointment slots**: in referrals mode, the next upcoming demo slots across
  all clinics from Cosmos (including `booked`/`blocked` status, clinic names
  cached for five minutes); in demo/cloud mode, the state-store slots with
  booked status derived from appointments. Once a patient and referral are
  identified on the selected call, the panel automatically narrows to that
  referral's clinic and service (with a "show all" toggle), and the call list
  shows the identified demo patient's name.

The page polls `/monitor/api/state` every 2.5 seconds; slot results are cached
server-side for 10 seconds so polling does not hammer Cosmos, and monitor reads
are not written to the operational log (only `monitor_slots_failed` failures
are). All `/monitor` routes
require the token via the `?token=` query or an `Authorization: Bearer` header
and return 401 otherwise; leaving `MONITOR_TOKEN` empty disables the routes
entirely. The dashboard displays synthetic demo data only, but treat the token
like a credential anyway since transcripts are visible to anyone holding it.

## Boundaries and next steps

- **Not production-ready or a claim of HIPAA compliance.** Before real use:
  privacy/security and clinical review, applicable vendor agreements/BAAs,
  approved regions and retention policies, encryption/access controls,
  managed identities, audit trails, and incident-response procedures.
- There is no patient authentication, authorization, EHR integration, clinical
  triage, cancellation workflow, reminder delivery, or real-time audio streaming.
  Patient verification must precede any real appointment lookup or change.
- Configure real scheduling rules, visit lengths, provider/location calendars,
  accessibility/language support, escalation ownership, and emergency messaging
  with the hospital. The model must never act as a clinical decision maker.
- Caller speech is processed by Twilio and, in cloud mode, sent to
  Elasticsearch and Azure OpenAI. With referral AI enabled, natural-language
  requests are sent to Azure OpenAI as described above. Raw speech text is not stored by this app.
  Configure vendor-side logging/retention separately. Never test with PHI.
- Call state retains the last generated prompt, pending action, and turn counter.
  Sessions expire after 30 minutes and are removed lazily on the next successful
  state write; this is **not** a guaranteed deletion or backup-retention policy.
  The shared demo caps active calls at 100 and each call at 20 turns.
- Concurrent aggregate writes fail closed with an explicit uncertainty message
  and handoff, rather than claiming success. Staff should check the schedule
  before retrying an uncertain operation. The aggregate is a demo bottleneck.
- Terminal logs contain structured lifecycle/error metadata, not request bodies,
  phone numbers, transcripts, credentials, or raw upstream error messages.
  Add privacy-reviewed centralized observability and alerting before deploying.
- Cloud requests have short timeouts and disabled LLM/search retries to fit
  voice webhook latency, but live Twilio latency, cloud availability, and
  end-to-end staff transfers still require testing with configured accounts.
