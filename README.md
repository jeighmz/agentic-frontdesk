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

   Expect `{"status":"ok","mode":"demo","syntheticDataOnly":true}`.

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

## Read-only referral appointment availability

This mode uses Cosmos DB and the existing Twilio voice interface, **without
Azure OpenAI or Elasticsearch**. The Azure OpenAI adapter exists for the original
`MODE=cloud` flow, but is not called in `MODE=referrals`.

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
- Booking, confirmation, and rescheduling are explicitly disabled: no slots are
  reserved and no patient/referral documents are changed.

The voice service performs reads only and requires Cosmos data-plane read
access; the slot seeder requires write access. Only documents matching the demo
schemas/markers are accepted. **Full-name matching is not identity verification.**
There is no patient authentication, so never use this mode with real patient
data. Call state is process-local, expires after
30 minutes of inactivity on the next request, and resets on restart. Use a single
app instance for this demo; multiple instances would need shared call state.
The same 100-active-call and 20-turn demo limits apply.

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
  (`cosmos.patient.read`, `cosmos.patient.name_query`, `cosmos.clinic.read`, or
  `cosmos.slots.query`), duration,
  and safe error details. Container checks are logged at startup as well.
- `voice_request_failed`: sanitized error type, Cosmos HTTP/substatus codes and
  activity ID when available, troubleshooting hints, or schema issue field
  paths/codes. Raw error messages, stacks, documents, and validation values are
  deliberately excluded.
- `voice_request_rejected`: signature failures (403) or malformed payloads (400).
  Check `PUBLIC_BASE_URL`, the current tunnel URL, and `TWILIO_AUTH_TOKEN` if
  signature validation fails.
- `voice_request_slow`: no response after 8 seconds; this is a warning, not a
  change to request timeouts. `voice_request_aborted` means the connection closed
  before a response finished.

Logs sharing a request ID belong to the same webhook request. If Twilio says
"an application error has occurred" but no request-start log appears, check the
tunnel and Twilio **Monitor → Logs → Calls** error details. If a request starts
but stalls, the last dependency-start log identifies the operation to investigate.
HTTP 200 on the final error response means the app returned a spoken error/handoff
message, **not** that the requested operation succeeded.

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
  Elasticsearch and Azure OpenAI. Raw speech text is not stored by this app.
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
