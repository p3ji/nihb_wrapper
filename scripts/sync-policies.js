import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import path from "node:path";
import pdf from "@cedrugs/pdf-parse";
import { GoogleGenAI } from "@google/genai";

// Text chunking parameters
const CHUNK_SIZE = 3000;
const CHUNK_OVERLAP = 500;
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

async function embedWithRetry(ai, contents, retries = 5, initialDelay = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: contents,
        config: {
          outputDimensionality: 768
        }
      });
      return response;
    } catch (err) {
      const isRateLimit = err.status === 429 || 
                          (err.message && err.message.includes("429")) || 
                          (err.message && err.message.toLowerCase().includes("quota")) ||
                          (err.message && err.message.toLowerCase().includes("limit"));
      
      if (isRateLimit && attempt < retries) {
        const delay = initialDelay * Math.pow(2, attempt - 1);
        console.log(`[Rate Limit 429] Retrying batch in ${delay / 1000}s (Attempt ${attempt}/${retries})...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        throw err;
      }
    }
  }
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

  // 1. Get existing blobs to identify files to prune and try loading current index
  let blobsList = [];
  try {
    const { blobs } = await store.list();
    blobsList = blobs || [];
  } catch (err) {
    console.log("Could not list existing blobs:", err.message);
  }

  const indexKey = "vector_index.json";
  let existingIndex = [];
  try {
    const rawIndex = await store.get(indexKey, { type: "text" });
    if (rawIndex) {
      existingIndex = JSON.parse(rawIndex);
      console.log(`Loaded existing index containing ${existingIndex.length} chunks.`);
    }
  } catch (err) {
    console.log("No existing index found or failed to read it:", err.message);
  }

  console.log(`Step 1: Extracting text and checking cache for ${files.length} PDFs...`);
  const allChunks = [];
  const embeddedChunks = [];

  for (const file of files) {
    const filePath = path.join(policiesDir, file);
    const stats = fs.statSync(filePath);
    const currentSize = stats.size;

    const cachedChunks = existingIndex.filter(c => c.source === file);
    if (cachedChunks.length > 0 && cachedChunks[0].fileSize === currentSize) {
      console.log(`Cache HIT for '${file}' (${currentSize} bytes). Reusing ${cachedChunks.length} existing embeddings.`);
      embeddedChunks.push(...cachedChunks);
      continue;
    }

    console.log(`Cache MISS for '${file}'. Parsing PDF...`);
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
    chunks.forEach(c => c.fileSize = currentSize);
    console.log(`Generated ${chunks.length} text chunks for '${file}'.`);
    allChunks.push(...chunks);
  }

  const sleep = ms => new Promise(res => setTimeout(res, ms));

  if (allChunks.length > 0) {
    console.log(`Step 2: Total new/modified chunks generated: ${allChunks.length}. Generating embeddings in batches of ${BATCH_SIZE}...`);
    const ai = new GoogleGenAI({ apiKey });

    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      const batch = allChunks.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);
      
      if (i > 0) {
        console.log("Sleeping for 4.5 seconds to respect rate limits...");
        await sleep(4500);
      }
      
      console.log(`Processing embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);
      
      try {
        const response = await embedWithRetry(ai, batch.map(c => c.text));

        const embeddings = response.embeddings || [];
        for (let j = 0; j < batch.length; j++) {
          const vector = embeddings[j]?.values || [];
          embeddedChunks.push({
            text: batch[j].text,
            source: batch[j].source,
            index: batch[j].index,
            fileSize: batch[j].fileSize,
            vector: vector
          });
        }
      } catch (err) {
        console.error(`Failed to generate embeddings for batch ${batchNum}:`, err);
        throw err;
      }
    }
  } else {
    console.log("Step 2: No new or modified chunks to embed. Cache is fully up to date.");
  }

  // 3. Save the entire pre-computed vector index in Netlify Blobs
  console.log(`Step 3: Uploading pre-indexed vectors to Blobs under key '${indexKey}'...`);
  await store.set(indexKey, JSON.stringify(embeddedChunks));
  console.log(`Vector index successfully uploaded (${embeddedChunks.length} total chunks).`);

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
