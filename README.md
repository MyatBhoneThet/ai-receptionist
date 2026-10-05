version 1.1.0 = google calendar integration
version 1.1.1 = containerization(docker compose)
version 1.2.0 = speech to text recognition
version 1.2.1 = migration to tailwind css
version 1.2.2 = github workflow for neon db(test deployment)
version 1.2.4 = add rate-limiting and helmet to api routes, ai orb animation
version 1.2.5 = Jenkins CI/CD integration

# AI Receptionist

An intelligent Hotel & Restaurant Receptionist powered by AI, designed to handle bookings, inquiries, and customer interactions seamlessly.

## Features

- **AI-Powered Conversations**: Natural language interaction for handling complex customer intents.
- **Smart Booking System**: 
  - 🍽️ **Restaurant**: Book tables with guest counts and specific times.
  - 🏨 **Hotel**: Manage check-ins, check-outs, and room reservations.
  - 🤝 **Meetings**: Schedule meeting rooms and locations.
- **Booking Changes**: Accepts dates such as “day after tomorrow” or “seventh October this year”, including guest and phone changes in the same message.
- **Reservation Types**: Explicit hotel, restaurant, and meeting types take priority over incidental room/table words. Corrections preserve other details, and conflicting types prompt clarification. Search criteria are shown separately from a saved reservation.
- **Google Calendar Sync**: Updates the existing Calendar event when a booking changes and reports whether synchronization succeeded.
- **Speech Capabilities**: Stops listening after an utterance and places the transcript in the editable input. The responsive speech sphere stays above the input while listening.
- **Database Persistence**: Reliable storage of conversations and bookings using PostgreSQL (Neon DB).
- **Security Hardened**: 
  - Multi-tier rate limiting (Global, Chat, and Bookings).
  - Secure HTTP headers via Helmet.
  - Tightened CORS configuration.
- **Containerized**: Ready for production with Docker and Docker Compose.

## Tech Stack

### Frontend
- **Framework**: [Next.js 14+](https://nextjs.org/) (App Router)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)

### Backend
- **Runtime**: [Node.js](https://nodejs.org/) with [Express](https://expressjs.com/)
- **AI/LLM**: [Groq SDK](https://console.groq.com/) / [Google Gemini API](https://ai.google.dev/)
- **Database**: [PostgreSQL](https://www.postgresql.org/) (hosted on [Neon](https://neon.tech/))
- **APIs**: [Googleapis](https://github.com/googleapis/google-api-python-client) (Calendar API)
- **Validation**: [Zod](https://zod.dev/)

## Setup & Installation

### Prerequisites
- Node.js (v18+)
- PostgreSQL Database (or Neon account)
- Google Cloud Service Account (for Calendar sync)
- API Keys for Groq or Gemini

### 1. Clone the Repository
```bash
git clone https://github.com/MyatBhoneThet/ai-receptionist.git
cd AI-Receptionist
```

### 2. Configure Environment Variables
Copy [`.env.example`](/Users/myatbhonethet/Downloads/AI-Receptionist/.env.example) to `.env` in the project root and fill in real values.

**Required values:**
```env
DATABASE_URL=postgres_url
GROQ_API_KEY=groq_key
GROQ_MODEL=openai/gpt-oss-120b
PORT=4000
FRONTEND_URL=http://localhost:3000
SESSION_SIGNING_SECRET=long_random_secret
ADMIN_TOKEN=long_random_admin_token
ENABLE_LEGACY_ADMIN_TOKEN_FALLBACK=true
DB_SSL_REJECT_UNAUTHORIZED=true
TRUST_PROXY=false
GOOGLE_CALENDAR_ID=email
GOOGLE_CLIENT_EMAIL=service_account_email
GOOGLE_PRIVATE_KEY="private_key"
CALENDAR_TIMEZONE=Asia/Bangkok
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_ENABLE_LOCALSTORAGE_AUTH_FALLBACK=true
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
STAFF_ALERT_EMAIL=
STAFF_WEBHOOK_URL=
STAFF_WEBHOOK_PROVIDER=slack
```

`GROQ_MODEL` is optional and defaults to `openai/gpt-oss-120b`. Set it in
`backend/.env` for local development or your backend host's environment settings
to select another Groq model that supports JSON mode. The former default,
`llama-3.3-70b-versatile`, was retired for free and developer accounts on August 16,
2026; see [Groq's deprecation notice](https://console.groq.com/docs/deprecations).
Restart or redeploy the backend after changing environment variables.

### 3. Install Dependencies
```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 4. Initialize an Empty Database
`db:init` resets all application tables. Use it only for an empty database or an
intentional reset.

```bash
cd backend
npm run db:init
npm run db:seed:inventory
```

That schema includes the application settings and audit tables used by the admin settings, booking, and inventory screens.

For an existing database initialized with the former `customers.phone` column,
apply the customer phone migration instead. It preserves the existing customer
records and renames the column to `phone_number`, as required by booking and
customer-memory queries:

```bash
cd backend
npm run db:migrate:customer-phone
```

### 5. Run the Application
From the project root, start both the backend and frontend:
```bash
npm run dev
```

Or start each service separately in its own terminal:
```bash
# Start backend (from /backend)
npm run dev

# Start frontend (from /frontend)
npm run dev
```

Default ports are:
- Backend: `4000`
- Frontend: `3000`

If one is already in use, change `PORT` in `backend/.env` or `NEXT_PUBLIC_API_URL`/the frontend dev port to match your local setup.

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

For a detailed guide, see [docker_guide.md](file:///Users/myatbhonethet/.gemini/antigravity/brain/5438f82b-f374-47c5-9c14-37d684df9c06/docker_guide.md).


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
- **Rate Limiting**: Configured in `backend/middleware/rateLimiter.js` to protect against brute-force and API abuse.
- **Helmet**: Protects the app from well-known web vulnerabilities by setting HTTP headers appropriately.
- **Input Validation**: Strict schema validation for all API requests using Zod.
- **Session Proofs**: Session-scoped booking reads and confirmations require a backend-signed session token.
- **Admin Protection**: Analytics and privileged booking mutation routes require `ADMIN_TOKEN`.
- **Notifications**: Optional booking confirmation/reminder/cancellation/VIP alerts can be sent by SMTP, Twilio, and staff webhooks. Set `STAFF_WEBHOOK_PROVIDER=slack` or `teams` to match the destination format.
- **Legacy Fallbacks**: The app still supports the old admin token header and localStorage session token flow for compatibility. Set `ENABLE_LEGACY_ADMIN_TOKEN_FALLBACK=false` and `NEXT_PUBLIC_ENABLE_LOCALSTORAGE_AUTH_FALLBACK=false` when you want to remove them.
- **Audit Trail**: Notification settings, bookings, and inventory changes are written to `audit_logs` and surfaced in the admin settings page.
- **Secrets Hygiene**: Do not commit real `.env` or service-account credentials. Rotate any secret that was previously committed.

---
*Created by [MyatBhoneThet](https://github.com/MyatBhoneThet)*
