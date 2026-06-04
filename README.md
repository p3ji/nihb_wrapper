# NIHB Policy Manuals Query Wrapper Application

A secure serverless web application deployed on Netlify that acts as an intelligent query interface for NIHB (Non-Insured Health Benefits) policy manuals. This project uses the **Strategy 2 (Multi-PDF Blob Storage)** approach, pairing **Netlify Blobs** for multi-document indexing with **Google Gemini 2.5 Flash** for high-context policy querying.

---

## Architecture Overview

1. **GitHub / Git-Sync Ingestion**: You check in policy PDF manuals under the `/policies` folder of your Git repository. During build or deployment, a custom script `scripts/sync-policies.js` runs automatically to ingest and synchronize those PDFs into a persistent Netlify Blob store namespace named `nihb-policies`.
2. **Serverless Backend**: An asynchronous Netlify Function (`netlify/functions/query-policy.js`) serves as the query wrapper. It retrieves the PDFs concurrently from Netlify Blobs, loads them as base64 buffers, and dispatches them alongside the user query to the `gemini-2.5-flash` model.
3. **Responsive Interface**: A modern dark-themed glassmorphic UI (`public/index.html`) handles input submission, manages loading indicators, and presents policy answers in markdown (supporting lists, bolding, and tables).

---

## Local Setup & Simulation Guide

### Prerequisites
Make sure you have Node.js (version 20+) and the Netlify CLI installed globally:
```bash
npm install -g netlify-cli
```

---

### Step 1: Install Dependencies
Run the installation command inside the project root directory:
```bash
npm install
```

---

### Step 2: Authenticate and Link Netlify CLI
To emulate Netlify Blobs locally, the CLI needs to be linked to a Netlify site:

1. **Login to Netlify**:
   ```bash
   netlify login
   ```
2. **Link Project to Netlify**:
   Create a new site or link to an existing site (this registers the site ID for Blob operations):
   ```bash
   netlify link
   ```

---

### Step 3: Setup Local Environment Variables
Create a file named `.env` in the root of the directory and specify your Gemini API Key:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
```

---

### Step 4: Seeding PDFs to Netlify Blobs

#### Option A: Automatic Git-Sync (Recommended)
1. Place your NIHB master manuals and monthly update PDF files directly in the `/policies` directory:
   ```text
   /policies/nihb-dental-policy-2026.pdf
   /policies/nihb-vision-update-may2026.pdf
   ```
2. Trigger the local synchronization script to upload them to your development store namespace:
   ```bash
   npm run build
   ```

#### Option B: Manual Upload via Netlify CLI
If you prefer not to commit large PDFs to Git, you can seed the `nihb-policies` store namespace manually via the CLI using `netlify blobs:set`:
```bash
netlify blobs:set nihb-policies master-dental-policy.pdf --input ./path/to/local/master-dental-policy.pdf
netlify blobs:set nihb-policies update-may-2026.pdf --input ./path/to/local/update-may-2026.pdf
```

---

### Step 5: Start Local Emulator
Start the local development server simulating Netlify Functions, Blobs, and Static hosting:
```bash
netlify dev
```
By default, this launches a local proxy environment at:
* **Frontend Dashboard**: [http://localhost:8888](http://localhost:8888)
* **Function Endpoint**: [http://localhost:8888/.netlify/functions/query-policy](http://localhost:8888/.netlify/functions/query-policy)

---

## CI/CD Netlify Deployment Setup

To deploy this project automatically on Netlify with automated GitHub Git-Sync:

1. Connect your repository to Netlify for continuous integration.
2. In the Netlify dashboard under **Site configuration > Build & deploy > Environment variables**, add:
   * `GEMINI_API_KEY`: Your Gemini API Key from Google AI Studio.
   * `NETLIFY_API_TOKEN`: A Personal Access Token generated in your Netlify User Settings (required for the build script to upload to Blobs).
3. The build command is already configured in `package.json` to run `npm run build`, which triggers the synchronization engine and uploads all PDFs in `/policies` to Blobs automatically on push!
