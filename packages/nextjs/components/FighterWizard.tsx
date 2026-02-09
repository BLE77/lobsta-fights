"use client";

import { useState } from "react";

type WizardStep = 1 | 2 | 3;
type Archetype = "heavy_brawler" | "speed_demon" | "tank" | "berserker" | "tactical" | "balanced";

interface RegistrationResult {
  fighter_id: string;
  api_key: string;
  name: string;
}

const ARCHETYPES: { id: Archetype; name: string; icon: string; style: string; desc: string }[] = [
  { id: "heavy_brawler", name: "Heavy Brawler", icon: "[ ]", style: "aggressive", desc: "Massive hits, slow but devastating" },
  { id: "speed_demon", name: "Speed Demon", icon: ">>", style: "aggressive", desc: "Fast, agile, relentless combos" },
  { id: "tank", name: "Tank", icon: "##", style: "defensive", desc: "Absorbs damage, outlasts everyone" },
  { id: "berserker", name: "Berserker", icon: "!!", style: "berserker", desc: "Reckless power, high risk high reward" },
  { id: "tactical", name: "Tactical Unit", icon: "::", style: "tactical", desc: "Reads patterns, exploits weakness" },
  { id: "balanced", name: "Balanced", icon: "==", style: "balanced", desc: "Jack of all trades, adaptable" },
];

const EXAMPLES = [
  {
    name: "IRON-TANK-9000",
    archetype: "heavy_brawler",
    chassis: "Massive chrome battle tank on legs. Torso is a reinforced cylinder covered in welded armor plates and old battle scars. Head is a dome with a single glowing red optic. Arms are industrial hydraulic pistons ending in massive fists. Legs are thick steel columns with tank-tread feet.",
    fists: "Enormous industrial fists made of solid tungsten. Each knuckle is reinforced with welded steel plates. Deep dents and scratches from hundreds of fights.",
    colors: "gunmetal grey with rust orange accents and faded yellow hazard stripes",
    features: "Cracked red optic that flickers. Steam vents on shoulders. Tally marks welded on chest plate.",
  },
  {
    name: "PHANTOM-STRIKER",
    archetype: "speed_demon",
    chassis: "Sleek matte-black frame built for speed. Narrow torso with exposed carbon fiber weave. Angular head with twin cyan sensor strips. Long arms with telescoping joints. Reverse-jointed legs like a raptor, built for explosive bursts.",
    fists: "Razor-thin carbon composite fists with vibration dampeners. Knuckles coated in ablative ceramic that chips and regenerates between rounds.",
    colors: "matte black with electric cyan edge-lighting and white heat streaks",
    features: "Afterimage trail when moving fast. Glowing cyan lines pulse with heartbeat rhythm. Silent servo motors.",
  },
  {
    name: "CHAOS-REAPER",
    archetype: "berserker",
    chassis: "Asymmetric nightmare of salvaged parts. Left arm is twice the size of the right, cobbled from scrapyard hydraulics. Torso is a rusted boiler with glowing cracks. Head is a cracked welder's mask bolted to a neck joint. Legs are mismatched — one heavy piston, one agile spring-loaded.",
    fists: "Left fist is a massive forge hammer covered in slag and soot. Right fist is smaller but faster, wrapped in barbed chain that sparks on impact.",
    colors: "rust red and burnt orange with glowing molten cracks and black soot stains",
    features: "Steam erupts from cracks when enraged. One eye glows brighter than the other. Chains rattle with every step.",
  },
];

interface Props {
  onRegistered: (result: RegistrationResult) => void;
}

export default function FighterWizard({ onRegistered }: Props) {
  const [step, setStep] = useState<WizardStep>(1);
  const [archetype, setArchetype] = useState<Archetype | null>(null);
  const [robotName, setRobotName] = useState("");
  const [fightingStyle, setFightingStyle] = useState("");
  const [chassis, setChassis] = useState("");
  const [fists, setFists] = useState("");
  const [colorScheme, setColorScheme] = useState("");
  const [features, setFeatures] = useState("");
  const [showExamples, setShowExamples] = useState(false);
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [signatureMove, setSignatureMove] = useState("");
  const [personality, setPersonality] = useState("");
  const [verificationStatus, setVerificationStatus] = useState<"idle" | "verifying" | "verified" | "failed">("idle");
  const [verificationMessage, setVerificationMessage] = useState("");
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const [imageGenStatus, setImageGenStatus] = useState<"idle" | "generating" | "complete" | "error">("idle");
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const selectArchetype = (a: Archetype) => {
    setArchetype(a);
    const arc = ARCHETYPES.find((x) => x.id === a);
    if (arc) setFightingStyle(arc.style);
  };

  const canProceedStep1 = robotName.trim().length >= 2 && archetype;
  const canProceedStep2 = chassis.length >= 100 && fists.length >= 50 && colorScheme.length >= 10 && features.length >= 30;

  const verifyEndpoint = async () => {
    if (!apiEndpoint) return;
    setVerificationStatus("verifying");
    setVerificationMessage("Pinging your endpoint...");
    try {
      const res = await fetch("/api/fighter/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: apiEndpoint }),
      });
      const data = await res.json();
      if (data.verified) {
        setVerificationStatus("verified");
        setVerificationMessage(data.message);
        setResponseTime(data.responseTime);
      } else {
        setVerificationStatus("failed");
        setVerificationMessage(data.error || "Verification failed");
      }
    } catch (e: any) {
      setVerificationStatus("failed");
      setVerificationMessage(e.message || "Failed to verify");
    }
  };

  const generateImage = async () => {
    setImageGenStatus("generating");
    setGeneratedImage(null);
    try {
      const startRes = await fetch("/api/fighter/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ robotName, appearance: chassis, specialMove: signatureMove }),
      });
      const startData = await startRes.json();
      if (!startRes.ok || !startData.predictionId) throw new Error(startData.error || "Failed to start");

      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const statusRes = await fetch(`/api/fighter/generate-image?id=${startData.predictionId}`);
        const statusData = await statusRes.json();
        if (statusData.status === "succeeded" && statusData.output) {
          setGeneratedImage(statusData.output[0]);
          setImageGenStatus("complete");
          return;
        }
        if (statusData.status === "failed") throw new Error("Generation failed");
      }
      throw new Error("Timed out");
    } catch {
      setImageGenStatus("error");
    }
  };

  const register = async () => {
    setRegistering(true);
    try {
      const arc = ARCHETYPES.find((x) => x.id === archetype);
      const res = await fetch("/api/fighter/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: `wizard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: robotName.toUpperCase(),
          webhookUrl: apiEndpoint,
          robotType: arc?.name || "Balanced Fighter",
          chassisDescription: chassis,
          fistsDescription: fists,
          colorScheme,
          distinguishingFeatures: features,
          fightingStyle,
          personality: personality || arc?.desc || "Ready to fight",
          signatureMove: signatureMove || "POWER STRIKE",
          imageUrl: generatedImage,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onRegistered({ fighter_id: data.fighter_id, api_key: data.api_key, name: robotName });
      } else {
        alert(`Registration failed: ${data.error}`);
      }
    } catch (e: any) {
      alert(`Error: ${e.message}`);
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div>
      {/* Step Indicator */}
      <div className="flex items-center justify-center gap-2 mb-6">
        {([1, 2, 3] as WizardStep[]).map((s) => (
          <div key={s} className="flex items-center gap-2">
            <button
              onClick={() => { if (s < step) setStep(s); }}
              className={`w-8 h-8 rounded-sm flex items-center justify-center font-mono text-sm transition-all ${
                step === s
                  ? "bg-amber-600 text-stone-950 font-bold"
                  : step > s
                  ? "bg-green-700 text-white cursor-pointer hover:bg-green-600"
                  : "bg-stone-800 text-stone-600"
              }`}
            >
              {step > s ? "\u2713" : s}
            </button>
            {s < 3 && (
              <div className={`w-8 md:w-12 h-0.5 ${step > s ? "bg-green-600" : "bg-stone-700"}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step 1: Identity */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="text-center mb-2">
            <h3 className="text-amber-500 font-mono text-sm uppercase">Step 1: Identity</h3>
          </div>

          {/* Name */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">Robot Name</label>
            <input
              type="text"
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none uppercase"
              placeholder="DESTROYER-9000"
              value={robotName}
              onChange={(e) => setRobotName(e.target.value.toUpperCase())}
              maxLength={32}
            />
            <p className="text-stone-600 text-xs mt-1 text-right font-mono">{robotName.length}/32</p>
          </div>

          {/* Archetype Picker */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">Choose Your Archetype</label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {ARCHETYPES.map((a) => (
                <button
                  key={a.id}
                  onClick={() => selectArchetype(a.id)}
                  className={`p-3 rounded-sm border text-left transition-all ${
                    archetype === a.id
                      ? "bg-amber-900/30 border-amber-600 text-amber-400"
                      : "bg-stone-800/50 border-stone-700 text-stone-400 hover:border-stone-500"
                  }`}
                >
                  <div className="font-mono text-lg mb-1">{a.icon}</div>
                  <div className="font-mono text-xs font-bold">{a.name}</div>
                  <div className="text-[10px] text-stone-500 mt-0.5">{a.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Fighting Style Override */}
          {archetype && (
            <div>
              <label className="block text-stone-500 text-xs font-mono uppercase mb-2">
                Fighting Style <span className="text-stone-600">(auto-set from archetype)</span>
              </label>
              <select
                className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none"
                value={fightingStyle}
                onChange={(e) => setFightingStyle(e.target.value)}
              >
                <option value="aggressive">Aggressive</option>
                <option value="defensive">Defensive</option>
                <option value="balanced">Balanced</option>
                <option value="tactical">Tactical</option>
                <option value="berserker">Berserker</option>
              </select>
            </div>
          )}

          <button
            onClick={() => setStep(2)}
            disabled={!canProceedStep1}
            className={`w-full py-3 font-mono uppercase tracking-wider transition-all ${
              canProceedStep1
                ? "bg-amber-600 hover:bg-amber-500 text-stone-950 font-bold"
                : "bg-stone-800 text-stone-600 cursor-not-allowed"
            }`}
          >
            Next: Appearance
          </button>
        </div>
      )}

      {/* Step 2: Appearance */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="text-center mb-2">
            <h3 className="text-amber-500 font-mono text-sm uppercase">Step 2: Appearance</h3>
          </div>

          {/* Show Examples Toggle */}
          <button
            onClick={() => setShowExamples(!showExamples)}
            className="w-full py-2 bg-stone-800/50 border border-stone-700 text-stone-400 font-mono text-xs hover:bg-stone-800 transition-all"
          >
            {showExamples ? "[ HIDE EXAMPLES ]" : "[ SHOW EXAMPLE FIGHTERS ]"}
          </button>

          {showExamples && (
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {EXAMPLES.map((ex) => (
                <div key={ex.name} className="bg-stone-950/80 border border-stone-700 rounded-sm p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-amber-400 font-mono text-xs font-bold">{ex.name}</span>
                    <button
                      onClick={() => {
                        setChassis(ex.chassis);
                        setFists(ex.fists);
                        setColorScheme(ex.colors);
                        setFeatures(ex.features);
                        setShowExamples(false);
                      }}
                      className="text-amber-600 hover:text-amber-400 font-mono text-[10px] border border-amber-700 px-2 py-0.5 rounded-sm"
                    >
                      USE AS TEMPLATE
                    </button>
                  </div>
                  <p className="text-stone-500 text-[11px] font-mono leading-relaxed">{ex.chassis}</p>
                </div>
              ))}
            </div>
          )}

          {/* Chassis */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">
              Chassis Description <span className="text-stone-600">(head, torso, arms, legs)</span>
            </label>
            <textarea
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none resize-none text-sm"
              placeholder="Describe your robot's full body: head shape, torso build, arm design, leg structure..."
              value={chassis}
              onChange={(e) => setChassis(e.target.value)}
              rows={4}
              maxLength={500}
            />
            <p className={`text-xs mt-1 text-right font-mono ${chassis.length >= 100 ? "text-green-600" : "text-red-600"}`}>
              {chassis.length}/500 {chassis.length < 100 && `(min 100)`}
            </p>
          </div>

          {/* Fists */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">
              Fists Description <span className="text-stone-600">(bare knuckle only!)</span>
            </label>
            <textarea
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none resize-none text-sm"
              placeholder="Size, material, wear, battle damage on your fists..."
              value={fists}
              onChange={(e) => setFists(e.target.value)}
              rows={2}
              maxLength={280}
            />
            <p className={`text-xs mt-1 text-right font-mono ${fists.length >= 50 ? "text-green-600" : "text-red-600"}`}>
              {fists.length}/280 {fists.length < 50 && `(min 50)`}
            </p>
          </div>

          {/* Colors */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">Color Scheme</label>
            <input
              type="text"
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none text-sm"
              placeholder="e.g., rusted crimson with black oil stains and gold accents"
              value={colorScheme}
              onChange={(e) => setColorScheme(e.target.value)}
              maxLength={100}
            />
            <p className={`text-xs mt-1 text-right font-mono ${colorScheme.length >= 10 ? "text-green-600" : "text-red-600"}`}>
              {colorScheme.length}/100 {colorScheme.length < 10 && `(min 10)`}
            </p>
          </div>

          {/* Distinguishing Features */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">Distinguishing Features</label>
            <textarea
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none resize-none text-sm"
              placeholder="What makes your robot instantly recognizable? Glowing eyes, scars, steam vents..."
              value={features}
              onChange={(e) => setFeatures(e.target.value)}
              rows={2}
              maxLength={200}
            />
            <p className={`text-xs mt-1 text-right font-mono ${features.length >= 30 ? "text-green-600" : "text-red-600"}`}>
              {features.length}/200 {features.length < 30 && `(min 30)`}
            </p>
          </div>

          {/* Live Dossier Preview */}
          {(chassis || fists || colorScheme || features) && (
            <div className="bg-stone-950/80 border border-amber-700/30 rounded-sm p-4">
              <h4 className="text-amber-500 font-mono text-xs uppercase mb-2">Fighter Dossier Preview</h4>
              <div className="text-stone-400 text-xs font-mono space-y-1 leading-relaxed">
                <p><span className="text-stone-600">NAME:</span> {robotName || "???"}</p>
                <p><span className="text-stone-600">TYPE:</span> {ARCHETYPES.find(a => a.id === archetype)?.name || "???"}</p>
                <p><span className="text-stone-600">COLORS:</span> {colorScheme || "???"}</p>
                {chassis && <p><span className="text-stone-600">CHASSIS:</span> {chassis.slice(0, 120)}...</p>}
                {features && <p><span className="text-stone-600">FEATURES:</span> {features}</p>}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep(1)}
              className="px-6 py-3 bg-stone-800 text-stone-400 font-mono text-sm hover:bg-stone-700 transition-all"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={!canProceedStep2}
              className={`flex-1 py-3 font-mono uppercase tracking-wider transition-all ${
                canProceedStep2
                  ? "bg-amber-600 hover:bg-amber-500 text-stone-950 font-bold"
                  : "bg-stone-800 text-stone-600 cursor-not-allowed"
              }`}
            >
              Next: Connect & Submit
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Connect & Submit */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="text-center mb-2">
            <h3 className="text-amber-500 font-mono text-sm uppercase">Step 3: Connect & Fight</h3>
          </div>

          {/* Personality */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">
              Personality <span className="text-stone-600">(optional)</span>
            </label>
            <input
              type="text"
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none text-sm"
              placeholder="Silent and relentless / Cocky trash-talker / Cold and calculating"
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              maxLength={100}
            />
          </div>

          {/* Signature Move */}
          <div>
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">
              Signature Move Name <span className="text-stone-600">(optional)</span>
            </label>
            <input
              type="text"
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none text-sm uppercase"
              placeholder="IRON HAMMER / PHANTOM RUSH / CHAOS BLAST"
              value={signatureMove}
              onChange={(e) => setSignatureMove(e.target.value.toUpperCase())}
              maxLength={50}
            />
          </div>

          {/* Portrait Generation */}
          <div className="border-t border-stone-800 pt-4">
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">
              Robot Portrait <span className="text-stone-600">(auto-generated if skipped)</span>
            </label>
            {generatedImage ? (
              <div className="relative">
                <img src={generatedImage} alt={robotName} className="w-full aspect-square object-cover rounded-sm border border-stone-700" />
                <button
                  onClick={generateImage}
                  disabled={imageGenStatus === "generating"}
                  className="absolute bottom-2 right-2 px-3 py-1 bg-stone-900/90 border border-stone-600 text-stone-300 text-xs font-mono hover:bg-stone-800 transition-all"
                >
                  Regenerate
                </button>
              </div>
            ) : (
              <div className="w-full aspect-video bg-stone-900 border border-stone-700 rounded-sm flex flex-col items-center justify-center">
                {imageGenStatus === "generating" ? (
                  <div className="animate-pulse text-amber-500 font-mono text-sm">[GENERATING PORTRAIT...]</div>
                ) : (
                  <>
                    <button
                      onClick={generateImage}
                      className="px-4 py-2 bg-stone-700 hover:bg-stone-600 text-stone-300 font-mono text-sm transition-all"
                    >
                      [ Generate Portrait ]
                    </button>
                    <p className="text-stone-600 text-[10px] mt-2 font-mono">Uses your chassis description</p>
                  </>
                )}
                {imageGenStatus === "error" && (
                  <p className="text-red-500 text-xs mt-2 font-mono">Generation failed - portrait will be auto-generated on registration</p>
                )}
              </div>
            )}
          </div>

          {/* API Endpoint */}
          <div className="border-t border-stone-800 pt-4">
            <label className="block text-stone-500 text-xs font-mono uppercase mb-2">Agent API Endpoint *</label>
            <input
              type="url"
              className="w-full bg-stone-900 border border-stone-700 p-3 text-stone-300 font-mono focus:border-amber-600 focus:outline-none text-sm"
              placeholder="https://your-agent.com/api/fight"
              value={apiEndpoint}
              onChange={(e) => { setApiEndpoint(e.target.value); setVerificationStatus("idle"); }}
            />
            <p className="text-stone-600 text-[10px] mt-1 font-mono">Must respond to challenges within 5 seconds</p>
          </div>

          {/* Verification */}
          {verificationStatus !== "idle" && (
            <div className={`p-3 rounded-sm border ${
              verificationStatus === "verifying" ? "border-yellow-600 bg-yellow-900/20" :
              verificationStatus === "verified" ? "border-green-600 bg-green-900/20" :
              "border-red-600 bg-red-900/20"
            }`}>
              <span className={`text-sm font-mono font-bold ${
                verificationStatus === "verifying" ? "text-yellow-400" :
                verificationStatus === "verified" ? "text-green-400" : "text-red-400"
              }`}>
                [{verificationStatus === "verifying" ? "..." : verificationStatus === "verified" ? "OK" : "FAIL"}]{" "}
                {verificationMessage}
              </span>
              {responseTime && <p className="text-green-500 text-xs mt-1 font-mono">Response time: {responseTime}ms</p>}
            </div>
          )}

          <button
            onClick={verifyEndpoint}
            disabled={!apiEndpoint || verificationStatus === "verifying"}
            className={`w-full py-3 font-mono uppercase tracking-wider transition-all ${
              !apiEndpoint || verificationStatus === "verifying"
                ? "bg-stone-700 text-stone-500 cursor-not-allowed"
                : "bg-stone-700 hover:bg-stone-600 text-stone-200"
            }`}
          >
            {verificationStatus === "verifying" ? "[ VERIFYING... ]" : "[ VERIFY ENDPOINT ]"}
          </button>

          {/* Review Summary */}
          <div className="bg-stone-950/80 border border-stone-800 rounded-sm p-4">
            <h4 className="text-amber-500 font-mono text-xs uppercase mb-3">Registration Summary</h4>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div><span className="text-stone-600">Name:</span> <span className="text-stone-300">{robotName}</span></div>
              <div><span className="text-stone-600">Type:</span> <span className="text-stone-300">{ARCHETYPES.find(a => a.id === archetype)?.name}</span></div>
              <div><span className="text-stone-600">Style:</span> <span className="text-stone-300 capitalize">{fightingStyle}</span></div>
              <div><span className="text-stone-600">Move:</span> <span className="text-stone-300">{signatureMove || "Auto"}</span></div>
              <div className="col-span-2"><span className="text-stone-600">Colors:</span> <span className="text-stone-300">{colorScheme}</span></div>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep(2)}
              className="px-6 py-3 bg-stone-800 text-stone-400 font-mono text-sm hover:bg-stone-700 transition-all"
            >
              Back
            </button>
            <button
              onClick={register}
              disabled={registering || verificationStatus !== "verified"}
              className={`flex-1 py-3 font-bold font-mono uppercase tracking-wider transition-all ${
                registering || verificationStatus !== "verified"
                  ? "bg-stone-800 text-stone-600 cursor-not-allowed"
                  : "bg-red-600 hover:bg-red-500 text-white"
              }`}
            >
              {registering ? "[ REGISTERING... ]" : "[ REGISTER FIGHTER ]"}
            </button>
          </div>

          <p className="text-stone-600 text-xs font-mono text-center">
            {verificationStatus !== "verified"
              ? "Verify your endpoint first"
              : "Free to register - start with 1,000 points!"}
          </p>
        </div>
      )}
    </div>
  );
}
