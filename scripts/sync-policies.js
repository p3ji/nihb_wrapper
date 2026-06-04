import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import path from "node:path";
import pdf from "@cedrugs/pdf-parse";

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

  // 1. Get existing blobs to identify files to prune
  let blobsList = [];
  try {
    const { blobs } = await store.list();
    blobsList = blobs || [];
  } catch (err) {
    console.log("Could not list existing blobs (might be empty or initial build):", err.message);
  }

  console.log(`Syncing ${files.length} PDF policies as plain text to Netlify Blob store...`);

  // 2. Extract text and upload local files
  for (const file of files) {
    const filePath = path.join(policiesDir, file);
    const key = file.replace(/\.pdf$/i, ".txt"); // Store as text key

    console.log(`Extracting text from '${file}'...`);
    const fileData = fs.readFileSync(filePath);
    
    let text = "";
    try {
      const data = await pdf(fileData);
      text = data.text || "";
    } catch (err) {
      console.error(`Error parsing PDF '${file}':`, err);
      throw err;
    }

    console.log(`Uploading extracted text (${text.length} characters) as blob key '${key}'...`);
    await store.set(key, text);
    console.log(`Successfully uploaded text for '${file}'.`);
  }

  // 3. Prune keys in Netlify that were deleted locally
  for (const b of blobsList) {
    // If it's a txt file, check if corresponding pdf exists locally
    if (b.key.endsWith(".txt")) {
      const matchingPdfName = b.key.replace(/\.txt$/i, ".pdf");
      if (!files.includes(matchingPdfName)) {
        console.log(`Blob key '${b.key}' was deleted locally. Deleting from Netlify Blobs...`);
        await store.delete(b.key);
        console.log(`Successfully deleted '${b.key}' from store.`);
      }
    } else {
      // Prune legacy binary PDFs or cache metadata keys to keep the store clean
      console.log(`Pruning legacy/metadata blob key '${b.key}' from store...`);
      await store.delete(b.key);
    }
  }

  console.log("Sync complete! All policy manuals stored successfully as plain text.");
}

sync().catch(err => {
  console.error("Error during synchronization process:", err);
  process.exit(1);
});
