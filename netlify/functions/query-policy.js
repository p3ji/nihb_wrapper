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

    // 4. Reference Netlify Blob store named 'nihb-policies'
    const store = getStore("nihb-policies");

    // 5. Dynamically read all available PDFs from the store
    const { blobs } = await store.list();
    if (!blobs || blobs.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No policy documents are currently loaded. Please upload PDF manuals to the 'nihb-policies' store first.",
          noDocuments: true
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${blobs.length} documents in blob store. Fetching concurrently...`);

    // 6. Fetch all PDFs concurrently into memory as base64 buffers
    const pdfParts = await Promise.all(
      blobs.map(async (blob) => {
        console.log(`Downloading document: ${blob.key} (${blob.size} bytes)`);
        const arrayBuffer = await store.get(blob.key, { type: "arrayBuffer" });
        const base64Data = Buffer.from(arrayBuffer).toString("base64");
        return {
          inlineData: {
            mimeType: "application/pdf",
            data: base64Data
          }
        };
      })
    );

    // 7. Combine all file buffers inline alongside user question
    const contents = [
      ...pdfParts,
      { text: question }
    ];

    // 8. Dispatch contents payload to 'gemini-2.5-flash' with system instruction config
    console.log("Sending payload to gemini-2.5-flash...");
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
      config: {
        systemInstruction: "You are an official NIHB policy assistant. Base your response strictly on the attached documents. Prioritize the newest chronological update files if conflicting rules overlap."
      }
    });

    // 9. Return the final generated text response cleanly as JSON
    return new Response(
      JSON.stringify({
        answer: response.text || "No response text generated.",
        sources: blobs.map(b => b.key)
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
    console.error("Unhandle exception in query-policy handler:", err);
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
