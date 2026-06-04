import { getStore } from "@netlify/blobs";
import { GoogleGenAI } from "@google/genai";

// Helper function to calculate dot product similarity between two normalized vectors
function dotProduct(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

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

    // 5. Retrieve pre-computed vector index from Blobs
    const indexKey = "vector_index.json";
    let vectorIndexRaw = null;
    try {
      vectorIndexRaw = await store.get(indexKey, { type: "text" });
    } catch (err) {
      console.error("Failed to read vector index from store:", err);
    }

    if (!vectorIndexRaw) {
      return new Response(
        JSON.stringify({
          error: "Vector index not found. Please trigger a deployment to compile and build the policy index.",
          noDocuments: true
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const vectorIndex = JSON.parse(vectorIndexRaw);
    if (!Array.isArray(vectorIndex) || vectorIndex.length === 0) {
      return new Response(
        JSON.stringify({
          error: "Vector index is empty. Please upload PDF manuals to the 'policies' folder and redeploy.",
          noDocuments: true
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log(`Loaded vector index containing ${vectorIndex.length} chunks.`);

    // 6. Generate embedding vector for the user's query
    console.log("Generating query embedding using gemini-embedding-2...");
    const embedResponse = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: question,
      config: {
        outputDimensionality: 768
      }
    });

    const questionVector = embedResponse.embeddings?.[0]?.values || embedResponse.embedding?.values;
    if (!questionVector) {
      throw new Error("Failed to retrieve query embedding values from Gemini.");
    }

    // 7. Calculate dot product similarity for all chunks and retrieve top 5 matches
    console.log("Computing similarities locally...");
    const scoredChunks = vectorIndex.map(chunk => ({
      text: chunk.text,
      source: chunk.source,
      index: chunk.index,
      score: dotProduct(questionVector, chunk.vector)
    }));

    // Sort descending by score
    scoredChunks.sort((a, b) => b.score - a.score);

    // Retrieve top 5 most relevant excerpts
    const topMatches = scoredChunks.slice(0, 5);
    console.log(`Retrieved top 5 matches. Highest score: ${(topMatches[0]?.score * 100).toFixed(1)}%`);

    // 8. Compile the retrieved excerpts into context
    const contextText = topMatches
      .map((match, i) => `[Excerpt ${i + 1} from manual '${match.source}']\n${match.text}`)
      .join("\n\n");

    const prompt = `CONTEXT POLICY MANUALS:\n${contextText}\n\nUSER QUESTION: ${question}`;

    // 9. Dispatch to 'gemini-2.5-flash'
    console.log("Sending prompt to gemini-2.5-flash...");
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: "You are an official NIHB policy assistant. Base your response strictly on the attached document excerpts. Prioritize the newest chronological update files if conflicting rules overlap. Cite the source manuals in your final answer."
      }
    });

    // 10. Return response with source files
    const uniqueSources = [...new Set(topMatches.map(m => m.source))];
    
    return new Response(
      JSON.stringify({
        answer: response.text || "No response text generated.",
        sources: uniqueSources,
        retrievedCount: topMatches.length
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
