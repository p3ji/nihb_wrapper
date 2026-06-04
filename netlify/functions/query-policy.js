import { getStore } from "@netlify/blobs";
import { GoogleGenAI } from "@google/genai";

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

    // 5. Dynamically read all available .txt files from the store
    const { blobs } = await store.list();
    const txtBlobs = (blobs || []).filter(b => b.key.endsWith(".txt"));

    if (txtBlobs.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No policy documents are currently loaded. Please upload PDF manuals to the 'nihb-policies' store first.",
          noDocuments: true
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${txtBlobs.length} text documents in blob store. Fetching concurrently...`);

    // 6. Fetch all text files concurrently
    const textDocuments = await Promise.all(
      txtBlobs.map(async (blob) => {
        console.log(`Downloading text document: ${blob.key}`);
        const textContent = await store.get(blob.key, { type: "text" });
        return {
          filename: blob.key.replace(/\.txt$/i, ".pdf"),
          content: textContent
        };
      })
    );

    // 7. Combine all file text contents inline as model context
    const combinedContext = textDocuments
      .map(doc => `=== Document: ${doc.filename} ===\n${doc.content}\n====================`)
      .join("\n\n");

    const prompt = `CONTEXT POLICY DOCUMENTS:\n${combinedContext}\n\nUSER QUESTION: ${question}`;

    // 8. Dispatch contents payload to 'gemini-2.5-flash' with system instruction config
    console.log("Sending query payload to gemini-2.5-flash...");
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: "You are an official NIHB policy assistant. Base your response strictly on the attached documents. Prioritize the newest chronological update files if conflicting rules overlap."
      }
    });

    // 9. Return the final generated text response cleanly as JSON
    return new Response(
      JSON.stringify({
        answer: response.text || "No response text generated.",
        sources: txtBlobs.map(b => b.key.replace(/\.txt$/i, ".pdf"))
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

    // Detect Gemini API Rate Limit / Quota Exceeded errors
    const isRateLimit = err.status === 429 || 
                        err.message?.toLowerCase().includes("429") || 
                        err.message?.toLowerCase().includes("quota") || 
                        err.message?.toLowerCase().includes("rate_limit") ||
                        err.message?.toLowerCase().includes("resource_exhausted");

    if (isRateLimit) {
      return new Response(
        JSON.stringify({
          error: "Gemini Free Tier Rate Limit Exceeded (250,000 input tokens/minute). Please wait 15 seconds and try again."
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
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
