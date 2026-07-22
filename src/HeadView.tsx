// HeadView — design a face, then talk to it.
//
// The face is Google GNM Head v3 exported as a rigged GLB with 67 morph targets
// (visemes, vowels, jaw/lip/tongue articulators, brows, gaze, blinks) by
// majidmanzarpour/threejs-talking-avatar. The verified runtime asset is bundled
// in public/models; see THIRD_PARTY_NOTICES.md for provenance and license terms.
//
// The voice is Pioneer's, end to end: mic → /api/v1/stt → /api/v1/lore (small
// in-character model, persona in `context`) → /api/v1/tts → mouth. Nothing runs
// locally except the render, so there are no multi-gigabyte model downloads —
// the reference repo's whole local-inference stack is replaced by four fetches.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { askLore, transcribe } from "./api";
import { ttsBytes, ttsStream } from "./pipeline";
import { playPcmStream, segmentSpeech } from "./speech";
import { SLIDERS } from "./headMorphs";
import { GnmFaceRig, VrmFaceRig, type FaceRig } from "./faceRig";
import { VrmLipSync } from "./VrmLipSync";
import { makeGltfLoader } from "./props";
import type { PS } from "./shared";
import {
  consumeCharacter,
  forgetHeadCharacter,
  loadHeadCharacter,
  rememberHeadCharacter,
  sendCharacter,
  type CharacterHandoff,
} from "./characterHandoff";
import VrmPicker from "./VrmPicker";
import { registerActions } from "./control";
import "./head.css";

const HEAD_URL = "/models/gnm-head.glb";
const DESIGN_KEY = "pioneer_studio_head_design";
const PERSONA_KEY = "pioneer_studio_head_persona";
const VOICE_KEY = "pioneer_studio_head_voice";

const DEFAULT_PERSONA =
  "You are a weathered frontier scout who has walked every ridge of this world. Warm, dry humour, never more than two sentences.";
// voxcpm2-tts designs a voice from plain language — the vocal half of the face.
const DEFAULT_VOICE = "older man, gravelly and unhurried, a trail-worn drawl";

type Turn = { id: number; who: "you" | "head"; text: string };

export default function HeadView({ ps, active }: { ps: PS; active: boolean }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [convo, setConvo] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [persona, setPersona] = useState(() => localStorage.getItem(PERSONA_KEY) || DEFAULT_PERSONA);
  const [voice, setVoice] = useState(() => localStorage.getItem(VOICE_KEY) ?? DEFAULT_VOICE);
  const [design, setDesign] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(DESIGN_KEY) || "{}");
    } catch {
      return {};
    }
  });
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [rigInfo, setRigInfo] = useState<{ label: string; canSpeak: boolean; designNames: string[]; extraNames: string[] } | null>(null);
  const [loadedCharacter, setLoadedCharacter] = useState<CharacterHandoff | null>(loadHeadCharacter);
  const [showAll, setShowAll] = useState(false);
  const loadVrmRef = useRef<((character: CharacterHandoff, persist?: boolean, forwardable?: boolean) => Promise<void>) | null>(null);

  // three-side handles the React tree never re-renders through
  const designRef = useRef(design);
  const gazeRef = useRef(gaze);
  const activeRef = useRef(active);
  const rigRef = useRef<FaceRig | null>(null);
  const lipRef = useRef<VrmLipSync | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const speakRef = useRef<AbortController | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const stopVadRef = useRef<(() => void) | null>(null);
  // True only while audio is actually sounding. The VAD reads this to raise its
  // barge-in bar, so the head cannot hear itself and interrupt itself.
  const soundingRef = useRef(false);
  const convoRef = useRef(false);
  // Bumped on every new utterance. An async turn checks it before each step and
  // bails if it is stale — that is how barge-in cancels the *whole* in-flight
  // turn (transcribe → lore → speak), not just the audio.
  const genRef = useRef(0);
  const voiceRef = useRef(voice);
  const nextId = useRef(1);
  const psRef = useRef(ps);
  psRef.current = ps;
  designRef.current = design;
  voiceRef.current = voice;
  gazeRef.current = gaze;
  activeRef.current = active;

  // GNM gets the curated label set; a loaded VRM advertises its own expressions,
  // so any authored base exposes exactly the shapes it actually has.
  // An authored VRM can export 90+ shapes. Listing them all
  // buries the panel — and buried the Persona/Voice fields entirely — so show
  // the handful of named moods by default and keep the rest behind "all".
  const sliders = !rigInfo
    ? SLIDERS
    : (showAll ? [...rigInfo.designNames, ...rigInfo.extraNames] : rigInfo.designNames).map((name) => ({
        name,
        label: SLIDERS.find((s) => s.name === name)?.label ?? name.replace(/_M$/, "").replace(/[_.]/g, " "),
      }));

  useEffect(() => localStorage.setItem(DESIGN_KEY, JSON.stringify(design)), [design]);
  useEffect(() => localStorage.setItem(PERSONA_KEY, persona), [persona]);
  useEffect(() => localStorage.setItem(VOICE_KEY, voice), [voice]);

  /* ── scene ── */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.5; // GNM's skin baseColor is a dark mid-brown
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 20);
    scene.add(new THREE.HemisphereLight(0xdfe9e0, 0x0a1410, 1.6));
    const key = new THREE.DirectionalLight(0xfff2d8, 2.2);
    key.position.set(0.6, 0.9, 1.4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fae8f, 1.1);
    rim.position.set(-1.2, 0.4, -1);
    scene.add(rim);

    const pivot = new THREE.Group();
    scene.add(pivot);

    let disposed = false;

    /** Swap whatever is on the pivot for a new rig and re-frame the camera. */
    const mount_ = (rig: FaceRig) => {
      if (rigRef.current) pivot.remove(rigRef.current.root);
      rigRef.current = rig;
      pivot.add(rig.root);
      rig.root.updateMatrixWorld(true);
      // Portrait framing that works for a bare head and for a full T-posed body
      // alike: measure how much asset sits ABOVE the eye line, never the overall
      // bounds — a VRM's bounding box is mostly arm span, and framing to that
      // puts the camera across the room.
      const focus = rig.focus();
      const above = Math.max(0.05, new THREE.Box3().setFromObject(rig.root).max.y - focus.y);
      rig.root.position.sub(focus);
      camera.position.set(0, 0, above * 5.7);
      camera.lookAt(0, 0, 0);
      setRigInfo({ label: rig.label, canSpeak: rig.canSpeak, designNames: rig.designNames, extraNames: rig.extraNames });
      setShowAll(false);
      setReady(true);
    };

    const stockReady = makeGltfLoader(renderer)
      .loadAsync(HEAD_URL)
      .then((gltf) => {
        if (disposed) return;
        const head = gltf.scene;
        head.traverse((o) => {
          o.frustumCulled = false;
          // The skin primitive's COLOR_0 is not colour — it's GNM's oral region
          // mask (r=upper lip, g=lower lip, b=mouth sock, a=perioral). glTF says
          // multiply it in, so out of the box the face wears bright red and
          // green lips. The GLB's own baseColorFactors are already sensible, so
          // dropping vertex colours is the whole fix.
          // The mask is ignored rather than interpreted. The reference asset's
          // gnmMaterials.ts turns it into real lip shading + a neck dissolve —
          // 220 lines and a custom shader. Port it if the face needs to sell a
          // close-up rather than read as a head.
          const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (mat?.vertexColors) {
            mat.vertexColors = false;
            mat.needsUpdate = true;
          }
          // The eye-socket shell is meant to be seen from inside; the GLB doesn't
          // say so, so its front faces render over the eyeballs and the face ends
          // up with two empty black sockets.
          if (mat?.name === "eye_interior") mat.side = THREE.BackSide;
        });
        mount_(new GnmFaceRig(head, SLIDERS.map((x) => x.name)));
      })
      .catch((e) => setErr(`${e.message || e} — the bundled head model could not be loaded`));

    // A URL entry point serves Create handoffs, the Media picker, persisted
    // characters, and local object URLs through the exact same loader.
    loadVrmRef.current = async (character: CharacterHandoff, persist = true, forwardable = persist) => {
      setReady(false);
      setErr("");
      setLoadedCharacter(null);
      try {
        // Establish a known-good stock rig first. A failed remote model then
        // leaves a usable head on screen rather than an empty Three scene.
        await stockReady;
        if (disposed) return;
        const loader = makeGltfLoader(renderer);
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await loader.loadAsync(character.vrmUrl);
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) throw new Error("not a VRM (no vrm extension)");
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        vrm.scene.traverse((o) => (o.frustumCulled = false));
        VRMUtils.rotateVRM0(vrm); // normalises VRM0.x onto the VRM1 facing convention
        mount_(new VrmFaceRig(vrm, character.name.replace(/\.vrm$/i, "")));
        setLoadedCharacter(forwardable ? character : null);
        if (persist) rememberHeadCharacter(character);
        else forgetHeadCharacter();
      } catch (e: any) {
        setErr(String(e.message || e));
        setReady(true);
        throw e;
      }
    };
    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let clock = 0;
    renderer.setAnimationLoop(() => {
      const dt = 1 / 60;
      clock += dt;
      if (!activeRef.current) return; // offscreen: hold the last frame, spend nothing
      const rig = rigRef.current;
      if (rig) {
        // One lip-sync engine serves both rigs: VrmLipSync reads the
        // playing audio and emits a VRM viseme + weight; the rig decides how to
        // wear it. Silence returns a null viseme, which closes the mouth.
        const lip = lipRef.current;
        const { viseme, weight } = lip ? lip.sample() : { viseme: null, weight: 0 };
        rig.setViseme(viseme, weight);
        for (const name of rig.designNames) rig.setExpression(name, designRef.current[name] ?? 0);
        const g = gazeRef.current;
        rig.setGaze(g.x, g.y);
        rig.update(dt);
      }
      renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      loadVrmRef.current = null;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  const restoredModelRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    const pending = consumeCharacter("head");
    const character = pending || (!restoredModelRef.current ? loadHeadCharacter() : null);
    restoredModelRef.current = true;
    if (!character) return;
    if (pending?.persona) setPersona(pending.persona);
    if (pending?.voice) setVoice(pending.voice);
    void loadVrmRef.current?.(character, !character.ephemeral, true).then(
      () => pending && psRef.current.toast(`${character.name} is ready to voice`, "gold"),
      () => {},
    );
  }, [active]);

  /* ── voice ── */
  function log(who: Turn["who"], t: string) {
    setTurns((v) => [...v.slice(-19), { id: nextId.current++, who, text: t }]);
  }

  /** One /tts/stream request for the whole answer, played chunk by chunk.
   *
   *  No clause chunking: the streaming route starts promptly for long inputs,
   *  so splitting the opener costs prosody without improving responsiveness.
   *  Falls back to the buffered wav route once if the stream fails. */
  async function speak(line: string, signal: AbortSignal) {
    const ctx = (audioRef.current ||= new AudioContext());
    await ctx.resume();
    const lip = (lipRef.current ||= new VrmLipSync(ctx));
    const wire = (src: AudioBufferSourceNode) => {
      src.connect(lip.input); // analysis tap — produces no sound
      src.connect(ctx.destination);
    };
    let sounded = false;
    const sounding = () => {
      sounded = true;
      soundingRef.current = true;
      setBusy("speaking…");
    };
    try {
      const res = await ttsStream(ps.apiKey, line, voiceRef.current, signal);
      await playPcmStream(ctx, res, wire, signal, sounding);
      return;
    } catch (e: any) {
      soundingRef.current = false;
      if (signal.aborted || e?.name === "AbortError") return;
      // Only retry on the buffered route if nothing was heard. A stream that
      // dies halfway has already played half the line; re-voicing the whole
      // thing would say the opening twice.
      if (sounded) throw e;
      setBusy("streaming voice down — using the buffered route…");
    }
    const bytes = await ttsBytes(ps.apiKey, line, voiceRef.current);
    if (signal.aborted) return;
    const buf = await ctx.decodeAudioData(bytes);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    wire(src);
    sounding();
    await new Promise<void>((done) => {
      signal.addEventListener("abort", () => { try { src.stop(); } catch { /* ended */ } done(); }, { once: true });
      src.onended = () => done();
      src.start();
    });
  }

  /** Cut the head off mid-sentence — talking over it, or sending a new line,
   *  interrupts the way a person does. Aborts the in-flight fetch too, so a
   *  barge-in during "voicing…" doesn't leave a request running. */
  function stopSpeaking() {
    speakRef.current?.abort();
    speakRef.current = null;
    soundingRef.current = false;
  }

  /** lore → voice. `gen` is the utterance this turn belongs to; if a newer one
   *  has started (the user interrupted) every step after that point is dropped. */
  async function respond(question: string, gen: number) {
    try {
      setBusy("thinking…");
      const answer = await askLore(ps.apiKey, question, persona);
      if (gen !== genRef.current) return;
      log("head", answer);
      setBusy("voicing…");
      const ac = new AbortController();
      speakRef.current = ac;
      try {
        await speak(answer, ac.signal);
      } finally {
        soundingRef.current = false;
      }
    } catch (e: any) {
      if (gen === genRef.current) setErr(String(e.message || e));
    } finally {
      if (gen === genRef.current) setBusy("");
    }
  }

  async function ask(question: string) {
    if (!ps.apiKey) return setErr("Add your Pioneer key in Settings first");
    stopSpeaking();
    setErr("");
    const gen = ++genRef.current;
    log("you", question);
    await respond(question, gen);
  }

  /** A whole turn from one recorded utterance. Silence transcribes to "" —
   *  that's a cough or a door, so it goes back to listening rather than
   *  reporting an error at someone who never spoke. */
  async function turn(audio: Blob, gen: number) {
    try {
      setBusy("transcribing…");
      const said = await transcribe(ps.apiKey, audio);
      if (gen !== genRef.current || !convoRef.current) return;
      if (!said) return setBusy("");
      log("you", said);
      await respond(said, gen);
    } catch (e: any) {
      if (gen === genRef.current) {
        setErr(String(e.message || e));
        setBusy("");
      }
    }
  }

  /** Open the mic and keep it open: VAD segments each utterance, and every
   *  segment runs a full turn on its own. One button, no push-to-talk. */
  async function startConvo() {
    if (!ps.apiKey) return setErr("Add your Pioneer key in Settings first");
    setErr("");
    try {
      // Echo cancellation is what makes an always-open mic viable at all —
      // without it the head's own voice comes back through the mic, trips the
      // VAD, and it interrupts itself in a loop.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micRef.current = stream;
      const ctx = (audioRef.current ||= new AudioContext());
      await ctx.resume();

      let rec: MediaRecorder | null = null;
      let chunks: Blob[] = [];
      stopVadRef.current = segmentSpeech(ctx, stream, {
        start: () => {
          // Capture, but commit to nothing yet — this may be a cough. Crucially
          // it must NOT cancel an in-flight turn: doing that on every blip is
          // what made the head answer "only sometimes", because a breath during
          // "thinking…" silently orphaned the real question.
          setHearing(true);
          chunks = [];
          // A fresh recorder per utterance can clip the first ~50ms,
          // because VAD only fires once the level is already up. Pre-roll needs
          // a continuously-running recorder, and a webm slice isn't decodable
          // without chunk 0's header — so it'd mean encoding wav by hand.
          rec = new MediaRecorder(stream);
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          rec.start();
        },
        hot: () => soundingRef.current,
        // It lasted long enough to be a real turn. NOW interrupt.
        speech: () => {
          stopSpeaking();
          genRef.current++;
          setBusy("");
        },
        end: (kept) => {
          setHearing(false);
          const r = rec;
          rec = null;
          if (!r) return;
          const gen = genRef.current;
          // A blip: stop the recorder to free it, then drop the audio on the
          // floor. Sending it to STT is what produced "Mm-hmm" / "Yeah" / "Oh".
          r.onstop = kept ? () => void turn(new Blob(chunks, { type: r.mimeType }), gen) : null;
          r.stop();
        },
      });
      convoRef.current = true;
      setConvo(true);
    } catch (e: any) {
      setErr(`mic: ${e.message || e}`);
    }
  }

  function stopConvo() {
    convoRef.current = false;
    genRef.current++; // orphan any turn still in flight
    setConvo(false);
    setHearing(false);
    setBusy("");
    stopVadRef.current?.();
    stopVadRef.current = null;
    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = null;
    stopSpeaking();
  }

  // Leaving the tab (or unmounting) must release the mic — an open capture
  // indicator on a tab the user has navigated away from reads as a bug.
  useEffect(() => {
    if (!active && convoRef.current) stopConvo();
  }, [active]);
  useEffect(() => () => stopConvo(), []);

  const actionFnsRef = useRef({ ask, startConvo, stopConvo });
  actionFnsRef.current = { ask, startConvo, stopConvo };
  useEffect(() => {
    registerActions([
      {
        name: "head.get_state",
        description: "Talking-head snapshot: loaded model, rig capabilities, persona, voice, conversation, and activity",
        run: () => ({ loadedCharacter, rig: rigInfo, persona, voice, conversation: convoRef.current, busy }),
      },
      {
        name: "head.load_vrm",
        description: "Load a VRM from a public URL",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Public .vrm URL" }, name: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
        run: (params) => {
          const url = String(params?.url || "");
          if (!url) throw new Error("url is required");
          return loadVrmRef.current?.({ id: `url:${url}`, name: String(params?.name || "Character"), vrmUrl: url });
        },
      },
      {
        name: "head.set_persona",
        description: "Set the character persona used for lore responses",
        parameters: { type: "object", properties: { persona: { type: "string" } }, required: ["persona"], additionalProperties: false },
        run: (params) => setPersona(String(params?.persona || "")),
      },
      {
        name: "head.set_voice",
        description: "Set the natural-language voice design",
        parameters: { type: "object", properties: { voice: { type: "string" } }, required: ["voice"], additionalProperties: false },
        run: (params) => setVoice(String(params?.voice || "")),
      },
      {
        name: "head.say",
        description: "Ask the character a line and speak its in-persona answer",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        confirmation: "Uses lore and text-to-speech services",
        run: (params) => actionFnsRef.current.ask(String(params?.text || "")),
      },
      {
        name: "head.start_conversation",
        description: "Open the microphone and start hands-free conversation",
        confirmation: "Opens the microphone and sends speech to transcription",
        run: () => actionFnsRef.current.startConvo(),
      },
      { name: "head.stop_conversation", description: "Stop conversation and release the microphone", run: () => actionFnsRef.current.stopConvo() },
    ]);
    // Action handlers intentionally read live refs/state through the current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedCharacter, rigInfo, persona, voice, busy]);

  return (
    <div className="head-root">
      <div className="head-stage" ref={mountRef} />

      <div className="head-panel">
        <div className="hp-panel-head">
          <div className="hp-title">Model</div>
          <div className="hp-model-actions">
            <VrmPicker
              ps={ps}
              className="sp-btn hp-load"
              label="Media…"
              onPick={(object) =>
                loadVrmRef.current?.({
                  id: `media:${object.key}`,
                  name: object.name.replace(/\.vrm$/i, ""),
                  vrmUrl: object.url,
                  persona,
                  voice,
                })
              }
            />
            <label className="sp-btn hp-load">
              File…
              <input
                type="file"
                accept=".vrm"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const url = URL.createObjectURL(file);
                  void loadVrmRef.current?.(
                    { id: `local:${file.name}:${file.lastModified}`, name: file.name.replace(/\.vrm$/i, ""), vrmUrl: url },
                    false,
                  ).catch(() => {}).finally(() => URL.revokeObjectURL(url));
                }}
              />
            </label>
          </div>
        </div>
        {rigInfo && (
          <div className={`hp-rig${rigInfo.canSpeak ? "" : " mute"}`}>
            <b>{rigInfo.label}</b>
            {rigInfo.canSpeak
              ? ` · ${rigInfo.designNames.length + rigInfo.extraNames.length} expressions`
              : " · no viseme shapes — this model cannot lip-sync"}
          </div>
        )}
        {loadedCharacter && (
          <button
            type="button"
            className="sp-btn hp-send"
            onClick={() => {
              sendCharacter("animate", { ...loadedCharacter, persona, voice });
              ps.setMode("animate");
            }}
          >
            Send {loadedCharacter.name} to Animation →
          </button>
        )}

        <div className="hp-title">Persona</div>
        <textarea className="hp-persona" rows={5} value={persona} onChange={(e) => setPersona(e.target.value)} />

        <div className="hp-title">Voice</div>
        <textarea className="hp-persona" rows={3} value={voice} onChange={(e) => setVoice(e.target.value)} />

        <div className="hp-panel-head">
          <div className="hp-title">Face</div>
          {!!rigInfo?.extraNames.length && (
            <button type="button" className="sp-btn hp-load" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "fewer" : `all ${rigInfo.designNames.length + rigInfo.extraNames.length}`}
            </button>
          )}
        </div>
        <div className="hp-sliders">
          {sliders.map((s) => (
            <label key={s.name} className="hp-slider">
              <span>{s.label}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={design[s.name] ?? 0}
                onChange={(e) => setDesign((d) => ({ ...d, [s.name]: +e.target.value }))}
              />
            </label>
          ))}
          <label className="hp-slider">
            <span>Gaze ↔</span>
            <input type="range" min={-1} max={1} step={0.02} value={gaze.x} onChange={(e) => setGaze((g) => ({ ...g, x: +e.target.value }))} />
          </label>
          <label className="hp-slider">
            <span>Gaze ↕</span>
            <input type="range" min={-1} max={1} step={0.02} value={gaze.y} onChange={(e) => setGaze((g) => ({ ...g, y: +e.target.value }))} />
          </label>
        </div>
        <button type="button" className="sp-btn" onClick={() => { setDesign({}); setGaze({ x: 0, y: 0 }); }}>
          Reset face
        </button>
      </div>

      <div className="head-convo">
        <div className="hc-log">
          {turns.map((t) => (
            <div key={t.id} className={`hc-turn ${t.who}`}>
              <b>{t.who === "you" ? "You" : "Head"}</b> {t.text}
            </div>
          ))}
          {!turns.length && (
            <div className="hc-hint">{ready ? "Start the conversation and just talk — or type a line below." : err || "Loading the head…"}</div>
          )}
        </div>
        {(convo || busy || err) && (
          <div className={`hc-status${err ? " bad" : ""}`}>
            {err || busy || (hearing ? "listening — go ahead…" : "waiting for you")}
          </div>
        )}
        <div className="hc-input">
          <button type="button" className={`sp-btn${convo ? " on" : ""}${hearing ? " hot" : ""}`} onClick={convo ? stopConvo : startConvo}>
            {convo ? "■ End conversation" : "● Start conversation"}
          </button>
          <input
            type="text"
            placeholder="…or type what you'd say"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !text.trim()) return;
              const q = text.trim();
              setText("");
              ask(q);
            }}
          />
        </div>
      </div>
    </div>
  );
}
