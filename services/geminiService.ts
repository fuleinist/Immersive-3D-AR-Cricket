import { ShotResult } from '../types';

/**
 * AI commentary is entirely optional. With no GEMINI_API_KEY set the app runs
 * fine on scripted local commentary — the @google/genai SDK is only ever
 * imported (and bundled into a separate lazy chunk) when a key exists.
 */
export const generateCommentary = async (
  result: ShotResult,
  speed: number,
  distance: number,
  deliveryName?: string,
): Promise<string | null> => {
  // Vite only substitutes process.env.* at build time, so guard for dev-mode
  // browsers where `process` does not exist at all.
  const apiKey = (typeof process !== 'undefined' && process.env?.API_KEY) || '';
  if (!apiKey) return null; // caller falls back to scripted commentary

  let prompt = `Write a short, exciting, 1-sentence cricket commentary in the style of a professional commentator (like Ravi Shastri or Richie Benaud).
  The batter just hit a shot with the following stats:
  Result: ${result}
  Ball Speed: ${speed.toFixed(1)} km/h
  Distance: ${distance.toFixed(1)} meters.
  `;

  if (deliveryName) {
    prompt += ` The delivery was the famous "${deliveryName}". Reference it if you can.`;
  }
  if (result === ShotResult.OUT) {
    prompt += " The batter is OUT! Express shock or disappointment.";
  } else if (result === ShotResult.SIX) {
    prompt += " It's a HUGE SIX! Express maximum excitement.";
  }

  try {
    // Lazy import: the SDK is only loaded when an API key is actually configured
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });
    return response.text?.trim() || null;
  } catch (error) {
    console.error("Gemini API Error:", error);
    return null;
  }
};
