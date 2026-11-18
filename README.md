# Agentic front desk

Initial **synthetic-data-only** hospital voice agent. No real appointments or
patient identities are supported. All callers share one fictional patient and
schedule. Do not route a real hospital number here or enter patient information.

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
# Set PUBLIC_BASE_URL and TWILIO_AUTH_TOKEN in .env.
npm run dev
```

`MODE=demo` uses in-memory storage, synthetic FAQs, and a deterministic planner.
It makes no Azure, Elasticsearch, or LLM calls. Data resets on restart.
Try “availability”, “book slot-2”, “yes”, “reschedule appointment-demo to slot-3”,
“hours”, “parking”, and “staff”. The demo planner accepts “slot two” or “slot 2”;
cloud mode lets the model interpret natural-language dates and times.
All spoken times use `HOSPITAL_TIME_ZONE`.

Expose port 3000 through an HTTPS tunnel or deploy behind HTTPS.
Set `PUBLIC_BASE_URL` to that exact public origin, without a trailing path.
In your Twilio phone number's Voice configuration, set **A call comes in** to
`https://your-public-host/voice`, method **POST**.
Set the Twilio account auth token, not an API key, in `TWILIO_AUTH_TOKEN`.
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
- Error logs contain categories only, not request bodies, phone numbers,
  transcripts, or upstream error messages. Add privacy-reviewed observability
  and actionable dependency monitoring before deploying.
- Cloud requests have short timeouts and disabled LLM/search retries to fit
  voice webhook latency, but live Twilio latency, cloud availability, and
  end-to-end staff transfers still require testing with configured accounts.
