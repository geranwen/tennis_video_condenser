
import React, { useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI } from "@google/genai";

const SYSTEM_PROMPT = `You are an expert Tennis Analyst. Your task is to analyze a video of a tennis match and extract specific segments for a highlight reel.

**Goal**: Output a JSON list of events containing active gameplay or significant moments.

**Definitions**:
1.  **Rally**: Begins with the serving motion and ends when the ball goes out of play or a point is scored.
2.  **Fault**: A served ball that lands outside the service box.
3.  **Double Fault**: Two consecutive Faults.
    *   *Heuristic*: If a player faults and stays on the SAME side to serve again, it is a "Fault". If they fault and then SWITCH sides (indicating the point is over), the second fault is a "Double Fault".

**Instructions**:
- Analyze the video timeline continuously.
- Identify every "Rally" and "Double Fault".
- Ignore "Faults" that do not result in a point (i.e., first serves that are faults). Only capture the "Double Fault" if it happens.
- For each identified event, provide:
    - "start_time": Timestamp (HH:MM:SS) when the serve motion begins.
    - "end_time": Timestamp (HH:MM:SS) when the rally ends.
    - "event_type": One of ["Rally", "Double Fault"].
    - "winning_shot": One of ["Forehand", "Backhand", "Volley", "Serve", "Overhead", "N/A"].
    - "winner": The name or descriptor of the player who won the point (e.g., "Server", "Receiver", "Top Player", "Bottom Player").

**Output Format**:
Return ONLY valid JSON. Do not include markdown formatting.
Schema:
[
  {
    "start_time": "00:00:05",
    "end_time": "00:00:15",
    "event_type": "Rally",
    "winning_shot": "Forehand",
    "winner": "Player A"
  }
]`;

const PYTHON_SCRIPT = `import json
import sys
import os
# Requires: pip install moviepy
# Note: ImageMagick is required for TextClip on some systems.
from moviepy.editor import VideoFileClip, TextClip, CompositeVideoClip, concatenate_videoclips

def time_to_seconds(time_str):
    """Converts HH:MM:SS or MM:SS to seconds."""
    parts = list(map(float, time_str.split(':')))
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    elif len(parts) == 2:
        return parts[0] * 60 + parts[1]
    else:
        return parts[0]

def create_highlight_reel(video_path, json_path, output_path="condensed_match.mp4"):
    print(f"--- Tennis Match Condenser ---")
    print(f"Video: {video_path}")
    print(f"Analysis: {json_path}")

    # Load Video
    if not os.path.exists(video_path):
        print(f"Error: Video file not found at {video_path}")
        sys.exit(1)
        
    try:
        video = VideoFileClip(video_path)
    except Exception as e:
        print(f"Error opening video: {e}")
        sys.exit(1)

    # Load Analysis JSON
    if not os.path.exists(json_path):
        print(f"Error: JSON file not found at {json_path}")
        sys.exit(1)

    try:
        with open(json_path, 'r') as f:
            events = json.load(f)
    except Exception as e:
        print(f"Error loading JSON: {e}")
        sys.exit(1)

    clips = []
    print(f"Processing {len(events)} identified events...")

    for i, event in enumerate(events):
        try:
            start_str = event.get('start_time', '00:00:00')
            end_str = event.get('end_time', '00:00:00')
            
            start = time_to_seconds(start_str)
            end = time_to_seconds(end_str)
            
            # Safety check: ensure logical duration
            if start >= end or end > video.duration:
                print(f"Skipping invalid interval [{i}]: {start_str} -> {end_str}")
                continue
                
            # Create subclip
            clip = video.subclip(start, end)
            
            # Overlay Text Info
            event_type = event.get('event_type', 'Rally')
            winner = event.get('winner', '')
            shot = event.get('winning_shot', '')
            
            info_text = f"{event_type} | {winner}\\n{shot}"
            
            # Try adding text overlay (Requires ImageMagick)
            try:
                # Configure font/size/color as needed
                txt_clip = TextClip(info_text, fontsize=30, color='white', font='Arial', bg_color='rgba(0,0,0,0.6)', method='caption', size=(clip.w // 3, None))
                # Position bottom-right with some padding
                txt_clip = txt_clip.set_position(('right', 'bottom')).set_duration(clip.duration)
                clip = CompositeVideoClip([clip, txt_clip])
            except Exception as txt_err:
                # Fallback if TextClip fails (common in moviepy without ImageMagick)
                print(f"Note: Could not add text overlay for clip {i}. (ImageMagick missing?)")
                pass

            clips.append(clip)
            
        except Exception as e:
            print(f"Error processing event {i}: {e}")
            continue

    if clips:
        print(f"Concatenating {len(clips)} clips...")
        final_clip = concatenate_videoclips(clips)
        final_clip.write_videofile(output_path, codec='libx264', audio_codec='aac', fps=video.fps)
        print(f"\\nSuccess! Saved condensed match to: {output_path}")
    else:
        print("No valid clips found to generate video.")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python condenser.py <raw_video.mp4> <analysis_output.json>")
    else:
        create_highlight_reel(sys.argv[1], sys.argv[2])
`;

const App = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setVideoFile(e.target.files[0]);
      setError(null);
      setAnalysisResult(null);
    }
  };

  const fileToGenerativePart = async (file: File) => {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
    };
  };

  const runAnalysis = async () => {
    if (!videoFile) {
      setError("Please select a video file first.");
      return;
    }

    // Updated Limit: 60MB
    if (videoFile.size > 60 * 1024 * 1024) {
      setError("For this web demo, please use a video file smaller than 60MB. The actual Python pipeline supports full matches!");
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setAnalysisResult(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const videoPart = await fileToGenerativePart(videoFile);
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: {
            parts: [
                videoPart,
                { text: "Analyze this tennis clip and output the rally JSON." }
            ]
        },
        config: {
            responseMimeType: "application/json",
            systemInstruction: SYSTEM_PROMPT
        }
      });

      setAnalysisResult(response.text || "No JSON returned.");
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An error occurred during analysis.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans p-6 pb-24">
      <header className="max-w-6xl mx-auto mb-8 border-b border-slate-700 pb-6 text-center">
        <h1 className="text-4xl font-bold text-green-400 mb-2 tracking-tight">🎾 Tennis Match Condenser</h1>
        <p className="text-slate-400 text-lg">
          Automated highlight generation using Gemini 3 Pro and Python.
        </p>
      </header>

      <main className="max-w-6xl mx-auto space-y-12">
        
        {/* PRIMARY SECTION: WEB DEMO */}
        <section className="bg-slate-800 rounded-2xl p-8 border border-slate-700 shadow-2xl animate-fadeIn">
          <div className="flex flex-col items-center text-center mb-8">
            <h2 className="text-3xl font-bold text-white mb-2">Live Analysis Demo</h2>
            <p className="text-slate-400 max-w-2xl">
              Upload a short video clip (Max 60MB) to see Gemini 3 Pro analyze rallies and faults in real-time. 
            </p>
          </div>
          
          <div className="max-w-2xl mx-auto">
            <div className="mb-8 relative group">
              <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
              <div className="relative bg-slate-900 rounded-lg p-6 border border-slate-700">
                 <label className="block text-sm font-medium text-slate-300 mb-4">
                  Select Tennis Match Clip
                </label>
                <input 
                  type="file" 
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={handleFileChange}
                  className="block w-full text-sm text-slate-400
                    file:mr-4 file:py-3 file:px-6
                    file:rounded-full file:border-0
                    file:text-sm file:font-bold
                    file:bg-slate-700 file:text-white
                    hover:file:bg-slate-600
                    cursor-pointer
                    bg-slate-800 rounded-lg
                    focus:outline-none
                  "
                />
              </div>
            </div>

            {error && (
              <div className="p-4 bg-red-900/30 border border-red-700 rounded-lg mb-6 text-red-200 text-sm flex items-center">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                {error}
              </div>
            )}

            <button
              onClick={runAnalysis}
              disabled={!videoFile || isAnalyzing}
              className={`w-full py-4 px-6 rounded-xl font-bold text-lg shadow-lg transition-all transform
                ${!videoFile || isAnalyzing 
                  ? 'bg-slate-700 text-slate-500 cursor-not-allowed' 
                  : 'bg-gradient-to-r from-green-600 to-emerald-600 text-white hover:from-green-500 hover:to-emerald-500 hover:scale-[1.02] hover:shadow-green-900/50'
                }`}
            >
              {isAnalyzing ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-3 h-6 w-6 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Analyzing Match Gameplay...
                </span>
              ) : "Analyze Footage"}
            </button>

            {analysisResult && (
              <div className="mt-10 animate-fadeIn">
                <div className="flex justify-between items-end mb-3">
                  <h3 className="text-lg font-semibold text-white flex items-center">
                    <svg className="w-5 h-5 mr-2 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    Analysis Results
                  </h3>
                  <button 
                    onClick={() => copyToClipboard(analysisResult)}
                    className="text-xs text-green-400 hover:text-green-300 font-medium px-3 py-1 bg-green-900/20 rounded hover:bg-green-900/40 transition-colors"
                  >
                    Copy JSON
                  </button>
                </div>
                <div className="bg-slate-950 rounded-xl p-6 border border-slate-800 shadow-inner overflow-hidden">
                  <pre className="text-sm text-green-400 font-mono overflow-x-auto">
                    {analysisResult}
                  </pre>
                </div>
                <p className="mt-4 text-sm text-slate-500 text-center">
                  To create the highlight reel, save this output as <code>analysis.json</code> and run the Python script below.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* SECONDARY SECTION: RESOURCES */}
        <div className="border-t border-slate-800 pt-12">
            <h2 className="text-2xl font-bold text-slate-200 mb-8 text-center">Developer Resources</h2>
            
            <div className="grid md:grid-cols-2 gap-8">
                
                {/* Prompt Card */}
                <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50 hover:border-slate-600 transition-colors">
                    <div className="flex justify-between items-center mb-4">
                        <div>
                            <h3 className="text-lg font-semibold text-blue-400">1. System Prompt</h3>
                            <p className="text-xs text-slate-500 mt-1">Deliverable for Gemini 3 Pro</p>
                        </div>
                        <button 
                            onClick={() => copyToClipboard(SYSTEM_PROMPT)}
                            className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-white transition-colors"
                        >
                            Copy
                        </button>
                    </div>
                    <div className="bg-slate-950 p-4 rounded-lg overflow-y-auto h-64 border border-slate-800 scrollbar-thin scrollbar-thumb-slate-700">
                        <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap">
                            {SYSTEM_PROMPT}
                        </pre>
                    </div>
                </div>

                {/* Script Card */}
                <div className="bg-slate-800/50 rounded-xl p-6 border border-slate-700/50 hover:border-slate-600 transition-colors">
                    <div className="flex justify-between items-center mb-4">
                        <div>
                            <h3 className="text-lg font-semibold text-purple-400">2. Python Editor Script</h3>
                            <p className="text-xs text-slate-500 mt-1">Requires <code>moviepy</code> library</p>
                        </div>
                        <button 
                            onClick={() => copyToClipboard(PYTHON_SCRIPT)}
                            className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-white transition-colors"
                        >
                            Copy
                        </button>
                    </div>
                    <div className="bg-slate-950 p-4 rounded-lg overflow-y-auto h-64 border border-slate-800 scrollbar-thin scrollbar-thumb-slate-700">
                        <pre className="text-xs text-purple-300 font-mono">
                            {PYTHON_SCRIPT}
                        </pre>
                    </div>
                </div>

            </div>
        </div>

      </main>
    </div>
  );
};

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
