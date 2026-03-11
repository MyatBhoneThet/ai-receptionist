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
- **Google Calendar Sync**: Automatic synchronization of bookings with Google Calendar via Service Account integration.
- **Speech Capabilities**: Integrated speech-to-text recognition for a voice-first experience.
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
Create `.env` files in both `backend` and `frontend` directories.

**Backend (`backend/.env`):**
```env
DATABASE_URL=postgres_url
GROQ_API_KEY=groq_key
PORT=4000
FRONTEND_URL=http://localhost:3000
GOOGLE_CALENDAR_ID=email
GOOGLE_CLIENT_EMAIL=service_account_email
GOOGLE_PRIVATE_KEY="private_key"
```

### 3. Install Dependencies
```bash
# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install
```

### 4. Initialize Database
```bash
cd backend
npm run db:init
```

### 5. Run the Application
```bash
# Start backend (from /backend)
npm run dev

# Start frontend (from /frontend)
npm run dev
```

## 🐳 Docker Support
Run the entire stack using Docker Compose:
```bash
docker-compose up --build
```

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

## Security
- **Rate Limiting**: Configured in `backend/middleware/rateLimiter.js` to protect against brute-force and API abuse.
- **Helmet**: Protects the app from well-known web vulnerabilities by setting HTTP headers appropriately.
- **Input Validation**: Strict schema validation for all API requests using Zod.

---
*Created by [MyatBhoneThet](https://github.com/MyatBhoneThet)*
