import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import path from "node:path";
import pdf from "@cedrugs/pdf-parse";
import { GoogleGenAI } from "@google/genai";

// Text chunking parameters
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const BATCH_SIZE = 50;

// Helper to chunk text
function chunkText(text, filename) {
  // Clean up formatting: compress multiple spaces/newlines
  const cleanText = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let start = 0;
  
  while (start < cleanText.length) {
    const end = Math.min(start + CHUNK_SIZE, cleanText.length);
    const chunk = cleanText.substring(start, end);
    chunks.push({
      text: chunk,
      source: filename,
      index: chunks.length
    });
    start += (CHUNK_SIZE - CHUNK_OVERLAP);
  }
  return chunks;
}

async function sync() {
  const policiesDir = path.join(process.cwd(), "policies");
  if (!fs.existsSync(policiesDir)) {
    console.log("Creating policies/ directory...");
    fs.mkdirSync(policiesDir, { recursive: true });
    fs.writeFileSync(path.join(policiesDir, ".gitkeep"), "");
  }

  const files = fs.readdirSync(policiesDir).filter(file => file.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) {
    console.log("No PDF policy files found in policies/ directory to synchronize.");
    return;
  }

  // Retrieve environment variables for Netlify and Gemini
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required to generate embeddings during build.");
  }

  let store;
  if (siteID && token) {
    console.log("Initializing Netlify Blobs store 'nihb-policies' in CI/Build mode with credentials...");
    store = getStore("nihb-policies", { siteID, token });
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
    console.log("Could not list existing blobs:", err.message);
  }

  console.log(`Step 1: Extracting text from ${files.length} PDFs...`);
  const allChunks = [];
  for (const file of files) {
    const filePath = path.join(policiesDir, file);
    console.log(`Parsing '${file}'...`);
    const fileData = fs.readFileSync(filePath);
    
    let parsedText = "";
    try {
      const data = await pdf(fileData);
      parsedText = data.text || "";
    } catch (err) {
      console.error(`Error parsing PDF '${file}':`, err);
      throw err;
    }

    const chunks = chunkText(parsedText, file);
    console.log(`Generated ${chunks.length} text chunks for '${file}'.`);
    allChunks.push(...chunks);
  }

  console.log(`Step 2: Total chunks generated: ${allChunks.length}. Generating embeddings in batches of ${BATCH_SIZE}...`);
  const ai = new GoogleGenAI({ apiKey });
  const embeddedChunks = [];

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);
    
    console.log(`Processing embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);
    
    try {
      const response = await ai.models.embedContent({
        model: "text-embedding-004",
        contents: batch.map(c => c.text)
      });

      const embeddings = response.embeddings || [];
      for (let j = 0; j < batch.length; j++) {
        const vector = embeddings[j]?.values || [];
        embeddedChunks.push({
          text: batch[j].text,
          source: batch[j].source,
          index: batch[j].index,
          vector: vector
        });
      }
    } catch (err) {
      console.error(`Failed to generate embeddings for batch ${batchNum}:`, err);
      throw err;
    }
  }

  // 3. Save the entire pre-computed vector index in Netlify Blobs
  const indexKey = "vector_index.json";
  console.log(`Step 3: Uploading pre-indexed vectors to Blobs under key '${indexKey}'...`);
  await store.set(indexKey, JSON.stringify(embeddedChunks));
  console.log("Vector index successfully uploaded.");

  // 4. Prune any old files, legacy text files, or cached files to keep storage clean
  for (const b of blobsList) {
    if (b.key !== indexKey) {
      console.log(`Pruning old/unused key '${b.key}' from store...`);
      await store.delete(b.key);
    }
  }

  console.log("Sync complete! RAG vector index compiled and deployed successfully.");
}

sync().catch(err => {
  console.error("Error during synchronization process:", err);
  process.exit(1);
});
