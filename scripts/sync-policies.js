import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import path from "node:path";

async function sync() {
  const policiesDir = path.join(process.cwd(), "policies");
  if (!fs.existsSync(policiesDir)) {
    console.log("Creating policies/ directory...");
    fs.mkdirSync(policiesDir, { recursive: true });
    // Write a .gitkeep to track the empty folder in Git
    fs.writeFileSync(path.join(policiesDir, ".gitkeep"), "");
  }

  const files = fs.readdirSync(policiesDir).filter(file => file.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) {
    console.log("No PDF policy files found in policies/ directory to synchronize.");
    return;
  }

  // Retrieve environment variables for CI authentication
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;

  let store;
  if (siteID && token) {
    console.log("Initializing Netlify Blobs store 'nihb-policies' in CI/Build mode with credentials...");
    store = getStore("nihb-policies", {
      siteID,
      token
    });
  } else {
    console.log("Initializing Netlify Blobs store 'nihb-policies' (using local/auto environment context)...");
    store = getStore("nihb-policies");
  }

  console.log(`Syncing ${files.length} PDF policies to Netlify Blob store...`);

  for (const file of files) {
    const filePath = path.join(policiesDir, file);
    const key = file; // Filename acts as the unique blob key

    console.log(`Uploading '${file}' as blob key '${key}'...`);
    const fileData = fs.readFileSync(filePath);
    await store.set(key, fileData);
    console.log(`Successfully uploaded '${file}'.`);
  }

  console.log("Sync complete! All policy manuals stored successfully.");
}

sync().catch(err => {
  console.error("Error during synchronization process:", err);
  process.exit(1);
});
// Trigger directory creation during initial script write
const policiesDir = path.join(process.cwd(), "policies");
if (!fs.existsSync(policiesDir)) {
  fs.mkdirSync(policiesDir, { recursive: true });
  fs.writeFileSync(path.join(policiesDir, ".gitkeep"), "");
}
