version 1.1.0 = google calendar integration
version 1.1.1 = containerization(docker compose)
version 1.2.0 = speech to text recognition
version 1.2.1 = migration to tailwind css
version 1.2.2 = github workflow for neon db(test deployment)
version 1.2.4 = add rate-limiting and helmet to api routes, ai orb animation
version 1.2.5 = Jenkins CI/CD integration

# AI Receptionist

A reusable booking platform with an AI receptionist. Businesses configure their own
**hotel rooms**, **meeting rooms** and **restaurant tables**, and guests book through
chat or voice. Staff run the day from a dashboard.

Full architecture, guarantees, migration notes and limitations: **[docs/PLATFORM.md](docs/PLATFORM.md)**.

## Features

- **Multiple independent businesses** in one deployment, each with its own inventory, reservations, customers, settings, staff and audit history.
- **Two operating modes per service**:
  - *Dashboard-managed* — this database is the authoritative booking record.
  - *External-system* — a connected PMS/reservation system is authoritative; this app checks and books through it. Only a clearly labelled **mock** connector exists today; no production PMS connector is included.
- **Configurable inventory**: service defaults → room/table types → individual rooms/tables with overrides and reset-to-default. Bulk creation makes distinct physical records with a code preview.
- **One booking layer** used by AI chat, staff, walk-ins and the waitlist, with transactional double-booking protection, idempotent commands, quotes, deposits, minimum spend and booking fees.
- **Daily operations**: check-in/out, seating, meetings, cleaning, maintenance blocks, overdue and conflict alerts.
- **AI conversations**: natural-language booking and changes; prices, availability and rules always come from the backend, never the model.
- **Booking changes**: dates such as “day after tomorrow” or “seventh October this year”, with guest and phone changes in the same message.
- **Google Calendar** as a downstream display that can never change a reservation.
- **Speech**: stops listening after an utterance and places the transcript in the editable input.

## Tech Stack

- **Frontend**: Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Backend**: Node.js, Express, Zod, PostgreSQL (`pg`), Groq SDK
- **Integrations**: Google Calendar API, SMTP / Twilio / Slack / Teams notifications

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL 13+ with the `btree_gist` extension available (it is on Neon and standard installs)
- A Groq API key
- Optional: a Google Cloud service account for Calendar

### 1. Configure environment
Copy [`.env.example`](.env.example) to `backend/.env` and `frontend/.env` and fill in values.
`SESSION_SIGNING_SECRET` is required. `INTEGRATION_ENCRYPTION_KEY` is required before adding an integration.

### 2. Install
```bash
cd backend && npm install
cd ../frontend && npm install
```

### 3. Create or upgrade the database
```bash
cd backend
npm run db:migrate
```
This applies the versioned, non-destructive migrations in `backend/migrations/`.

**Upgrading a database that already has bookings?** Read
[docs/PLATFORM.md §5](docs/PLATFORM.md#5-migrating-an-existing-database) first. You must
set `LEGACY_BUSINESS_TIMEZONE`, and the app will not work against the old schema until
the migration has run. Rehearse on a copy.

`db/schema.sql` is historical and **drops every table**. Do not run it on real data.

### 4. Run
```bash
npm run dev            # from the project root: backend on 4000, frontend on 3000
```

### 5. First use
1. Open `/login`, register, and you are taken to **Setup** to create your business.
2. Choose services and the booking source for each, add inventory, then activate.
3. Share the guest link: `/?business=<your public booking identifier>`.

For a ready-made demo business (internal restaurant/meeting, mock-external hotel):
```bash
cd backend && npm run demo:seed -- --email you@example.com --password "choose-a-password"
```

### Tests
```bash
cd backend && npm test                              # real PostgreSQL integration tests + unit tests
cd frontend && npm run test:voice && npm run build
```
Backend tests need a local PostgreSQL. They create and use `ai_receptionist_test`
(override with `TEST_DATABASE_URL`, whose database name must contain `test`) and never
touch the `DATABASE_URL` in `.env`.

## 🐳 Docker Support
Run the entire stack using Docker Compose:
```bash
docker-compose up --build
```

4. **Push**: `docker compose build && docker compose push`

### Run with Docker Hub
If you want to pull and run the images on a new server:
```bash
docker compose pull && docker compose up -d
```
*(Note: Ensure your `.env` files are present in the same directory.)*

Run `npm run db:migrate` (for example `docker compose run --rm backend npm run db:migrate`) before starting a new or upgraded deployment.


## Continuous Integration (Jenkins)

This project includes a `Jenkinsfile` for automated CI/CD. To use it:

1.  **Set up Jenkins**: Ensure Jenkins is installed with the **Pipeline**, **Git**, and **NodeJS** plugins.
2.  **Node.js**: Configure a NodeJS tool named **'node20'** (v20.x+) in *Manage Jenkins > Global Tool Configuration*.
3.  **Docker**: Ensure Docker and **Docker Compose V2** are installed. The Jenkins user must have permission to use Docker (usually by adding them to the `docker` group).
4.  **Create Pipeline**: Create a new "Pipeline" job in Jenkins and point it to this repository.
5.  **Run Build**: Jenkins will automatically run the stages defined in the `Jenkinsfile`:
    -   **Checkout**: Pulls the code from the repository.
    -   **Install Dependencies**: Installs `npm` packages for both `backend` and `frontend`.
    -   **Build Frontend**: Runs `npm run build` to verify the Next.js build.
    -   **Docker Build**: Verifies that the containers can be built using the `docker build` command.

### ⚓ Troubleshooting Docker Permissions
If the pipeline fails at the "Docker Build" stage with a **Permission Denied** error, follow these steps on the Jenkins server:
1.  **Add user to group**:
    ```bash
    sudo usermod -aG docker jenkins
    ```
2.  **Restart Jenkins**:
    ```bash
    sudo systemctl restart jenkins
    ```

**If Jenkins is running inside Docker:**
Ensure your `docker-compose` or `docker run` command for Jenkins includes:
`-v /var/run/docker.sock:/var/run/docker.sock`
And run this on the **host** to grant immediate access (for debugging):
```bash
sudo chmod 666 /var/run/docker.sock
```

### 🛠 Troubleshooting Git/SCM Errors
If you see **"fatal: not in a git directory"** in Jenkins:
1.  **Lightweight Checkout**: In the Job Configuration, under "Pipeline", ensure **"Lightweight checkout"** is **DISABLED**.
2.  **Wipe Workspace**: 
    -   Go to the Job's main page.
    -   Click **"Wipe Out Current Workspace"** (on the left sidebar, likely under "Workspace").
3.  **Check Git path**: Ensure the "Git" executable is correctly configured in *Manage Jenkins > Global Tool Configuration*.

## 🚨 DEFINITIVE FIX: Resolving "fatal: not in a git directory"
This error is caused by a bug in the Jenkins Git Plugin's "Lightweight Checkout" feature. To fix it:

1.  **Open Jenkins Job Configuration**.
2.  Scroll down to the **Pipeline** section.
3.  Change **Definition** from "Pipeline script from SCM" to **"Pipeline script"**.
4.  Paste the contents of the `Jenkinsfile` (found in this repo) directly into the **Script** text box.
5.  **Add** this Stage at the very top of your `stages` block in the script box:
    ```groovy
    stage('Checkout') {
        steps {
            checkout scm
        }
    }
    ```
6.  **Uncheck** "Lightweight checkout" (if it's still visible).
7.  **Save and Build**.

This bypasses the broken plugin phase and starts the job immediately.

## Security
- **Business isolation**: every staff route checks the signed-in user's membership of the business on the server. A business ID from the browser grants nothing.
- **Roles**: owners/admins manage configuration, integrations and access; staff manage reservations and operations.
- **Guest sessions** are signed for one business; a session or booking ID from another business finds nothing.
- **No authentication shortcuts**: the former `ALLOW_PUBLIC_ADMIN_ACCESS` switch and static `X-Admin-Token` have been removed.
- **Integration credentials** are encrypted at rest and never returned to the browser, logged, or given to the AI.
- **Rate limiting** (`backend/middleware/rateLimiter.js`), **Helmet** headers and **Zod** validation on all booking requests.
- **Audit trail**: configuration, inventory, booking and access changes are recorded per business.
- **Secrets hygiene**: do not commit real `.env` or service-account credentials. Rotate any secret that was previously committed.

---
*Created by [MyatBhoneThet](https://github.com/MyatBhoneThet)*
