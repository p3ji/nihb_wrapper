import pdf from "pdf-parse";
import fs from "node:fs";

async function test() {
  try {
    const dataBuffer = fs.readFileSync("./policies/bulletin_merge.pdf");
    const data = await pdf(dataBuffer);
    console.log("SUCCESS!");
    console.log("Pages:", data.numpages);
    console.log("Extracted Text Length:", data.text.length);
    console.log("First 100 characters:", data.text.substring(0, 100).replace(/\r?\n/g, ' '));
  } catch (err) {
    console.error("FAILED to parse PDF:", err);
  }
}

test();
