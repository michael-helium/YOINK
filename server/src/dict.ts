// server/src/dict.ts
import https from "https";

export async function loadWordlists(urls: string[]): Promise<Set<string>> {
  const dict = new Set<string>();

  for (const url of urls) {
    const text = await fetchText(url);
    // Parse line-by-line. Keep only a–z letters, length >= 2. Uppercase for fast compare.
    for (const raw of text.split(/\r?\n/)) {
      const w = raw.trim();
      if (!w) continue;
      if (!/^[a-zA-Z]+$/.test(w)) continue;
      if (w.length < 2) continue;
      dict.add(w.toUpperCase());
    }
  }
  return dict;
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}
