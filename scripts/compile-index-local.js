import fs from "node:fs";
import path from "node:path";
import pdf from "@cedrugs/pdf-parse";
import { GoogleGenAI } from "@google/genai";

// Text chunking parameters
const CHUNK_SIZE = 6000;
const CHUNK_OVERLAP = 1000;
const BATCH_SIZE = 30;

// Helper to chunk text
function chunkText(text, filename) {
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

// Embed content with retry logic using direct REST API to prevent SDK concurrent call rate limits
async function embedWithRetry(contents, retries = 5, initialDelay = 3000) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = "gemini-embedding-2";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;

  const payload = {
    requests: contents.map(text => ({
      model: `models/${model}`,
      content: {
        parts: [{ text }]
      },
      outputDimensionality: 768
    }))
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!res.ok) {
        const error = new Error(data.error?.message || "Gemini REST API Error");
        error.status = res.status;
        throw error;
      }

      return data;
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

async function compile() {
  const policiesDir = path.join(process.cwd(), "policies");
  const cacheDir = path.join(process.cwd(), ".cache");
  const cacheFilePath = path.join(cacheDir, "local_index_cache.json");
  const outputFilePath = path.join(process.cwd(), "netlify", "functions", "vector_index.json");

  // Ensure directories exist
  if (!fs.existsSync(policiesDir)) {
    console.error("policies/ directory not found!");
    process.exit(1);
  }
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const files = fs.readdirSync(policiesDir).filter(file => file.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) {
    console.log("No PDF files found in policies/ directory.");
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required to generate embeddings.");
  }

  // Load existing cache if present
  let cacheIndex = [];
  if (fs.existsSync(cacheFilePath)) {
    try {
      cacheIndex = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
      console.log(`Loaded cache from .cache/local_index_cache.json containing ${cacheIndex.length} chunks.`);
    } catch (err) {
      console.log("Could not parse cache file, starting fresh:", err.message);
    }
  }

  console.log(`Step 1: Extracting text and checking cache for ${files.length} PDFs...`);
  const allChunks = [];
  const embeddedChunks = [...cacheIndex]; // Start with cached chunks

  for (const file of files) {
    const filePath = path.join(policiesDir, file);
    const stats = fs.statSync(filePath);
    const currentSize = stats.size;

    console.log(`Parsing PDF '${file}' (${currentSize} bytes)...`);
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

    // Filter chunks that are NOT already in the cache with the same fileSize
    const newChunks = [];
    
    // Clear the entries for this file in embeddedChunks so we don't get duplicates
    for (let i = embeddedChunks.length - 1; i >= 0; i--) {
      if (embeddedChunks[i].source === file) {
        embeddedChunks.splice(i, 1);
      }
    }

    for (const chunk of chunks) {
      const cached = cacheIndex.find(c => 
        c.source === file && 
        c.index === chunk.index && 
        c.fileSize === currentSize && 
        c.vector && 
        c.vector.length > 0
      );

      if (cached) {
        embeddedChunks.push(cached);
      } else {
        newChunks.push(chunk);
      }
    }

    console.log(`Generated ${chunks.length} chunks for '${file}'. Cache: ${chunks.length - newChunks.length} hits, ${newChunks.length} misses.`);
    allChunks.push(...newChunks);
  }

  const sleep = ms => new Promise(res => setTimeout(res, ms));

  if (allChunks.length > 0) {
    console.log(`Step 2: Total new/modified chunks to embed: ${allChunks.length}. Generating embeddings in batches of ${BATCH_SIZE}...`);
    const ai = new GoogleGenAI({ apiKey });

    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      const batch = allChunks.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);
      
      if (i > 0) {
        console.log("Sleeping for 15 seconds to respect rate limits...");
        await sleep(15000);
      }
      
      console.log(`Processing embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);
      
      try {
        const response = await embedWithRetry(batch.map(c => c.text), 5, 12000);
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

        // Save progress to cache after every batch succeeds!
        fs.writeFileSync(cacheFilePath, JSON.stringify(embeddedChunks), "utf8");
        console.log(`Saved batch ${batchNum} embeddings to cache.`);

      } catch (err) {
        console.error(`Failed to generate embeddings for batch ${batchNum}:`, err);
        throw err;
      }
    }
  } else {
    console.log("Step 2: No new or modified chunks to embed. Local cache is fully up to date.");
  }

  // Save the final vector index
  console.log(`Step 3: Writing final compiled vector index to '${outputFilePath}'...`);
  // Ensure the output folder exists
  const outputDir = path.dirname(outputFilePath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputFilePath, JSON.stringify(embeddedChunks), "utf8");
  console.log(`Success! Vector index contains ${embeddedChunks.length} total chunks.`);
}

compile().catch(err => {
  console.error("Error during compilation process:", err);
  process.exit(1);
});
