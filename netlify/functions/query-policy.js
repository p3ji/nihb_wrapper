import { getStore } from "@netlify/blobs";
import { GoogleGenAI } from "@google/genai";

// Cache parameters (expiring after 40 hours to stay safe within Gemini's 48-hour limit)
const CACHE_INFO_KEY = "__gemini_cache_info__";
const CACHE_TTL_SECONDS = 40 * 60 * 60; 

export default async (req, context) => {
  // 1. Restrict traffic to incoming HTTP POST requests
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method Not Allowed. Only POST requests are accepted." }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }

  try {
    // 2. Extract the question string safely from the request body
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Invalid JSON format in request body." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { question } = body;
    if (!question || typeof question !== "string" || question.trim() === "") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'question' parameter. It must be a non-empty string." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Initialize Google Gen AI client
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is not configured in the environment variables.");
      return new Response(
        JSON.stringify({ error: "Internal Server Configuration Error. Gemini API key is missing." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    const ai = new GoogleGenAI({ apiKey });

    // 4. Reference Netlify Blob store
    const store = getStore("nihb-policies");

    // 5. Dynamically read all available PDFs from the store
    const { blobs } = await store.list();
    
    // Filter out our internal cache metadata key
    const pdfBlobs = (blobs || []).filter(b => b.key !== CACHE_INFO_KEY);

    if (pdfBlobs.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No policy documents are currently loaded. Please upload PDF manuals to the 'nihb-policies' store first.",
          noDocuments: true
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // 6. Retrieve existing cache metadata
    let cacheInfo = null;
    try {
      cacheInfo = await store.get(CACHE_INFO_KEY, { type: "json" });
    } catch (e) {
      console.log("No previous cache metadata found.");
    }

    let cacheName = cacheInfo?.cacheName;
    let expiresAt = cacheInfo?.expiresAt || 0;

    // Check if files changed: Create a unique hash of current filenames and sizes
    const currentKeysHash = pdfBlobs.map(b => `${b.key}-${b.size}`).sort().join(",");
    const cachedKeysHash = cacheInfo?.keysHash;

    // Validate cache (with a 10-minute safety buffer prior to real expiry)
    const isCacheValid = cacheName && (Date.now() < (expiresAt - 10 * 60 * 1000)) && (currentKeysHash === cachedKeysHash);

    if (!isCacheValid) {
      console.log("Context cache is missing, expired, or files changed. Rebuilding cache...");

      // 6a. Fetch all PDFs from Blobs
      console.log(`Downloading ${pdfBlobs.length} files from Blobs...`);
      const pdfFiles = await Promise.all(
        pdfBlobs.map(async (blob) => {
          const arrayBuffer = await store.get(blob.key, { type: "arrayBuffer" });
          return {
            key: blob.key,
            buffer: Buffer.from(arrayBuffer)
          };
        })
      );

      // 6b. Upload PDFs to the Gemini Files API
      console.log("Uploading files to Gemini Files API...");
      const uploadedParts = await Promise.all(
        pdfFiles.map(async (file) => {
          console.log(`Uploading ${file.key} to Gemini File Manager...`);
          const blobObject = new Blob([file.buffer], { type: "application/pdf" });
          const uploadResult = await ai.files.upload({
            file: blobObject,
            mimeType: "application/pdf",
            config: { displayName: file.key }
          });
          console.log(`Uploaded ${file.key} successfully as ${uploadResult.name}`);
          
          return {
            fileData: {
              fileUri: uploadResult.uri,
              mimeType: uploadResult.mimeType
            }
          };
        })
      );

      // 6c. Create the new context cache resource
      console.log("Initializing Gemini Context Cache...");
      const systemInstruction = "You are an official NIHB policy assistant. Base your response strictly on the attached documents. Prioritize the newest chronological update files if conflicting rules overlap.";
      const model = "gemini-2.5-flash";

      const newCache = await ai.caches.create({
        model,
        config: {
          displayName: "nihb_policies_cache",
          contents: [
            {
              role: "user",
              parts: uploadedParts
            }
          ],
          systemInstruction,
          ttl: `${CACHE_TTL_SECONDS}s`
        }
      });

      console.log(`Successfully created context cache: ${newCache.name}`);
      cacheName = newCache.name;
      expiresAt = Date.now() + CACHE_TTL_SECONDS * 1000;

      // 6d. Save the cache metadata back to Netlify Blobs
      await store.set(CACHE_INFO_KEY, JSON.stringify({
        cacheName,
        expiresAt,
        keysHash: currentKeysHash
      }));
    } else {
      console.log(`Utilizing existing valid context cache: ${cacheName}`);
    }

    // 7. Dispatch query to 'gemini-2.5-flash' referencing the Cache ID
    console.log(`Querying Gemini using cached context: ${cacheName}...`);
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: question }] }],
      config: {
        cachedContent: cacheName
      }
    });

    // 8. Return response
    return new Response(
      JSON.stringify({
        answer: response.text || "No response text generated.",
        sources: pdfBlobs.map(b => b.key),
        cached: true
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );

  } catch (err) {
    console.error("Error in query-policy handler:", err);
    
    // Invalidate cached info in case of a caching mismatch or deletion on Gemini's end
    if (err.message?.toLowerCase().includes("cache") || err.message?.toLowerCase().includes("not_found")) {
      try {
        const store = getStore("nihb-policies");
        await store.delete(CACHE_INFO_KEY);
        console.log("Invalidated cache metadata due to Gemini API cache retrieval failure.");
      } catch (e) {
        console.error("Failed to delete cache info key:", e);
      }
    }

    return new Response(
      JSON.stringify({ error: "Internal Server Error", message: err.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
};
