import { GoogleGenAI } from "@google/genai";
import { ShotResult } from '../types';

export const generateCommentary = async (result: ShotResult, speed: number, distance: number): Promise<string> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return "Great shot! (Configure API Key for AI commentary)";

  // Fresh instance per call as per guidelines
  const ai = new GoogleGenAI({ apiKey });

  let prompt = `Write a short, exciting, 1-sentence cricket commentary in the style of a professional commentator (like Ravi Shastri or Richie Benaud).
  The batter just hit a shot with the following stats:
  Result: ${result}
  Ball Speed: ${speed.toFixed(1)} km/h
  Distance: ${distance.toFixed(1)} meters.
  `;

  if (result === ShotResult.OUT) {
    prompt += " The batter is OUT! Express shock or disappointment.";
  } else if (result === ShotResult.SIX) {
    prompt += " It's a HUGE SIX! Express maximum excitement.";
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });
    // Use .text property (not a method)
    return response.text?.trim() || "What a play!";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "What a play!";
  }
};