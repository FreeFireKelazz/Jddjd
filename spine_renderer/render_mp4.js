import CanvasKitInit from "canvaskit-wasm";

import {
    loadTextureAtlas,
    loadSkeletonData,
    SkeletonDrawable,
    SkeletonRenderer
} from "@esotericsoftware/spine-canvaskit";

import {
    Physics,
    Vector2
} from "@esotericsoftware/spine-core";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";

// Bisa dioverride lewat env var ROOT/ASSET (dipakai di GitHub Actions).
// Kalau tidak diset, tetap pakai default lama di Termux.
const ROOT = process.env.ROOT || "/storage/emulated/0/pes/spine_renderer";
const ASSET = process.env.ASSET || "/storage/emulated/0/pes/spiker_sara";

// --------------------------------------------------------
// Auto-detect nama file .atlas/.json di dalam folder ASSET,
// jadi tidak perlu hardcode nama karakter (mis. "wingspike_sara").
// Ganti karakter cukup ganti isi folder ASSET, kode tidak perlu diubah.
// Asumsi standar Spine: <nama>.atlas berpasangan dengan <nama>.json.
// --------------------------------------------------------
function findSpineFiles(assetDir) {
    if (!fs.existsSync(assetDir)) {
        throw new Error(`Folder asset tidak ditemukan: ${assetDir}`);
    }

    const entries = fs.readdirSync(assetDir);
    const atlasFile = entries.find(f => f.toLowerCase().endsWith(".atlas"));
    if (!atlasFile) {
        throw new Error(`Tidak ada file .atlas di dalam ${assetDir}`);
    }

    const baseName = atlasFile.slice(0, -".atlas".length);
    let jsonFile = entries.find(f => f === `${baseName}.json`);
    if (!jsonFile) {
        // Fallback: file .json apa saja di folder itu (kalau nama tidak persis sama).
        jsonFile = entries.find(f => f.toLowerCase().endsWith(".json"));
    }
    if (!jsonFile) {
        throw new Error(`Tidak ada file .json (skeleton) di dalam ${assetDir}`);
    }

    console.log(`Asset terdeteksi: ${atlasFile} + ${jsonFile}`);

    return {
        atlas: path.join(assetDir, atlasFile),
        json: path.join(assetDir, jsonFile),
        baseName
    };
}

const SPINE_FILES = findSpineFiles(ASSET);
const ATLAS = SPINE_FILES.atlas;
const JSON_FILE = SPINE_FILES.json;
const OUTPUT = path.join(ROOT, `${SPINE_FILES.baseName}_action_idle.mp4`);

const FPS = Number(process.env.FPS || 60);
const PADDING = Number(process.env.PADDING || 2);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const ACTION_NAME = process.env.ACTION || "action";
const IDLE_NAME = process.env.IDLE || "idle";

// --------------------------------------------------------
// MODE dipakai untuk membagi kerja ke beberapa job GitHub
// Actions yang jalan paralel:
//   single -> perilaku lama: hitung bounds + render + encode
//             langsung jadi 1 mp4 dalam 1 proses (dipakai Termux).
//   bounds -> cuma hitung ukuran kanvas final (finalBounds) dan
//             totalFrames, ditulis ke BOUNDS_FILE (json).
//   frames -> baca BOUNDS_FILE, render frame FRAME_START..FRAME_END
//             (exclusive) jadi file PNG di folder FRAMES_OUT,
//             tanpa encode ke mp4.
// --------------------------------------------------------
const MODE = process.env.MODE || "single";
const BOUNDS_FILE = process.env.BOUNDS_FILE || path.join(ROOT, "bounds.json");
const FRAME_START = Number(process.env.FRAME_START || 0);
const FRAME_END = Number(process.env.FRAME_END || 0);
const FRAMES_OUT = process.env.FRAMES_OUT || path.join(ROOT, "frames");

function readFile(file) {
    return fs.readFileSync(file);
}

// --------------------------------------------------------
// Progress bar helper, biar keliatan jalan + ada estimasi
// waktu selesai (ETA), bukan cuma diam sampai muncul log.
// --------------------------------------------------------
function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

function printProgress(current, total, startTime) {
    const percent = Math.min(100, (current / total) * 100);
    const barLength = 24;
    const filled = Math.round((barLength * percent) / 100);
    const bar = "#".repeat(filled) + "-".repeat(barLength - filled);

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = current / Math.max(elapsed, 0.001);
    const remaining = rate > 0 ? (total - current) / rate : 0;

    const line = `  [${bar}] ${percent.toFixed(1)}%  (${current}/${total})  elapsed ${formatTime(elapsed)}  eta ${formatTime(remaining)}   `;
    process.stdout.write(`\r${line}`);

    if (current >= total) {
        process.stdout.write("\n");
    }
}

function createDrawable(skeletonData) {
    const drawable = new SkeletonDrawable(skeletonData);
    const skeleton = drawable.skeleton;
    skeleton.scaleX = 1;
    skeleton.scaleY = 1;
    skeleton.x = 0;
    skeleton.y = 0;
    return drawable;
}

function resetAndStart(drawable, animationName, loop = false) {
    const skeleton = drawable.skeleton;
    const state = drawable.animationState;

    skeleton.setToSetupPose();
    skeleton.x = 0;
    skeleton.y = 0;
    skeleton.scaleX = 1;
    skeleton.scaleY = 1;

    state.clearTracks();
    state.setAnimation(0, animationName, loop);
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.update);
}

function step(drawable, delta) {
    if (delta <= 0) return;

    const skeleton = drawable.skeleton;
    const state = drawable.animationState;

    state.update(delta);
    skeleton.update(delta);
    state.apply(skeleton);
    skeleton.updateWorldTransform(Physics.update);
}

function getBounds(skeleton) {
    const offset = new Vector2();
    const size = new Vector2();
    skeleton.getBounds(offset, size, []);

    return {
        minX: offset.x,
        minY: offset.y,
        maxX: offset.x + size.x,
        maxY: offset.y + size.y
    };
}

function updateUnion(dst, b) {
    dst.minX = Math.min(dst.minX, b.minX);
    dst.minY = Math.min(dst.minY, b.minY);
    dst.maxX = Math.max(dst.maxX, b.maxX);
    dst.maxY = Math.max(dst.maxY, b.maxY);
}

function newUnion() {
    return {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
}

function makeSequence(skeletonData) {
    const action = skeletonData.findAnimation(ACTION_NAME);
    const idle = skeletonData.findAnimation(IDLE_NAME);

    if (!action) throw new Error(`Animation "${ACTION_NAME}" tidak ditemukan.`);
    if (!idle) throw new Error(`Animation "${IDLE_NAME}" tidak ditemukan.`);

    return {
        action,
        idle,
        actionDuration: action.duration,
        idleDuration: idle.duration,
        totalDuration: action.duration + idle.duration
    };
}

function totalFramesFor(duration) {
    // Video duration is represented by frames at t = 0 ... (N-1)/FPS.
    // This gives N ~= duration * FPS and does not add an extra frame.
    return Math.max(1, Math.round(duration * FPS));
}

function createSequenceSimulator(skeletonData, sequence) {
    const drawable = createDrawable(skeletonData);
    resetAndStart(drawable, ACTION_NAME, false);

    let currentTime = 0;
    let idleStarted = false;

    function switchToIdle() {
        if (idleStarted) return;
        idleStarted = true;
        drawable.animationState.setAnimation(0, IDLE_NAME, false);
    }

    function advanceTo(targetTime) {
        if (targetTime < currentTime) {
            throw new Error("Sequence simulator hanya mendukung maju waktu.");
        }

        const EPS = 1e-10;

        while (currentTime + EPS < targetTime) {
            if (!idleStarted && currentTime < sequence.actionDuration - EPS) {
                const next = Math.min(targetTime, sequence.actionDuration);
                step(drawable, next - currentTime);
                currentTime = next;

                if (currentTime >= sequence.actionDuration - EPS) {
                    currentTime = sequence.actionDuration;
                    switchToIdle();
                }
            } else {
                if (!idleStarted) switchToIdle();
                step(drawable, targetTime - currentTime);
                currentTime = targetTime;
            }
        }

        if (!idleStarted && targetTime >= sequence.actionDuration - EPS) {
            currentTime = sequence.actionDuration;
            switchToIdle();
        }
    }

    return { drawable, advanceTo };
}

function makeSafeCanvasSize(worldBounds) {
    const minX = Math.floor(worldBounds.minX) - PADDING;
    const minY = Math.floor(worldBounds.minY) - PADDING;
    const maxX = Math.ceil(worldBounds.maxX) + PADDING;
    const maxY = Math.ceil(worldBounds.maxY) + PADDING;

    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY)
    };
}

function positionAndRender(ck, renderer, canvas, drawable, originX, originY, clearColor) {
    const skeleton = drawable.skeleton;

    skeleton.x = -originX;
    skeleton.y = -originY;
    skeleton.updateWorldTransform(Physics.none);

    canvas.clear(clearColor);
    renderer.render(canvas, drawable);
}

function snapshotToPng(ck, surface) {
    const image = surface.makeImageSnapshot();
    if (!image) throw new Error("CanvasKit makeImageSnapshot() gagal.");

    try {
        if (typeof image.encodeToBytes === "function") {
            const bytes = image.encodeToBytes();
            if (!bytes) throw new Error("CanvasKit encodeToBytes() gagal.");
            return Buffer.from(bytes);
        }

        // Compatibility fallback for CanvasKit builds that expose the
        // underlying Embind method instead of the JS convenience wrapper.
        if (typeof image._encodeToData === "function") {
            const data = image._encodeToData();
            if (!data) throw new Error("CanvasKit _encodeToData() gagal.");
            if (typeof data.bytes === "function") {
                return Buffer.from(data.bytes());
            }
            if (typeof data.toBytes === "function") {
                return Buffer.from(data.toBytes());
            }
        }

        throw new Error("CanvasKit Image tidak menyediakan encodeToBytes().");
    } finally {
        if (typeof image.delete === "function") image.delete();
    }
}

function decodePng(pngBytes) {
    const decoded = PNG.sync.read(pngBytes);
    return decoded.data;
}

function unionVisiblePixels(union, pixels, width, height) {
    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        for (let x = 0; x < width; x++) {
            if (pixels[row + x * 4 + 3] > 0) {
                if (x < union.minX) union.minX = x;
                if (y < union.minY) union.minY = y;
                if (x > union.maxX) union.maxX = x;
                if (y > union.maxY) union.maxY = y;
            }
        }
    }
}

function pixelUnionToFinalBounds(pixelUnion, safe) {
    if (pixelUnion.maxX < 0) throw new Error("Tidak ada pixel terlihat selama Action + Idle.");

    const width = pixelUnion.maxX - pixelUnion.minX + 1;
    const height = pixelUnion.maxY - pixelUnion.minY + 1;

    return {
        width,
        height,
        // Final skeleton origin in world coordinates.
        // safe origin maps to pixel 0; crop starts at pixelUnion.minX/minY.
        originX: safe.minX + pixelUnion.minX,
        originY: safe.minY + pixelUnion.minY,
        cropX: pixelUnion.minX,
        cropY: pixelUnion.minY
    };
}

function makeEvenDimensions(bounds) {
    // libx264rgb supports odd dimensions, so DO NOT alter dimensions.
    // This preserves the exact pixel-tight canvas.
    return bounds;
}

function startFFmpeg(width, height, output) {
    const args = [
        "-y",
        "-loglevel", "warning",
        "-f", "image2pipe",
        "-framerate", String(FPS),
        "-vcodec", "png",
        "-i", "-",
        "-an",
        "-c:v", "libx264",
        "-preset", process.env.PRESET || "medium",
        "-crf", process.env.CRF || "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output
    ];

    const ff = spawn(FFMPEG, args, { stdio: ["pipe", "inherit", "inherit"] });

    ff.on("error", err => {
        console.error("FFmpeg error:", err.message);
    });

    return ff;
}

function waitForProcess(proc) {
    return new Promise((resolve, reject) => {
        proc.on("close", code => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg berhenti dengan exit code ${code}.`));
        });
        proc.on("error", reject);
    });
}

function loadSequenceInfo(skeletonData) {
    const sequence = makeSequence(skeletonData);

    console.log(`Action : ${sequence.actionDuration.toFixed(6)} sec`);
    console.log(`Idle   : ${sequence.idleDuration.toFixed(6)} sec`);
    console.log(`Total  : ${sequence.totalDuration.toFixed(6)} sec`);
    console.log(`FPS    : ${FPS}`);

    const actionFrames = totalFramesFor(sequence.actionDuration);
    const idleFrames = totalFramesFor(sequence.idleDuration);
    const totalFrames = Math.max(1, actionFrames + idleFrames);

    console.log(`Frames : ${totalFrames}`);

    return { sequence, totalFrames };
}

async function computeFinalBounds(ck, skeletonData, sequence, totalFrames, renderer) {
    console.log("[3/7] Scanning Spine world bounds: Action + Idle...");

    const worldUnion = newUnion();
    const sim1 = createSequenceSimulator(skeletonData, sequence);
    const t1start = Date.now();

    for (let i = 0; i < totalFrames; i++) {
        const t = i / FPS;
        sim1.advanceTo(t);
        updateUnion(worldUnion, getBounds(sim1.drawable.skeleton));
        printProgress(i + 1, totalFrames, t1start);
    }

    const safe = makeSafeCanvasSize(worldUnion);

    console.log(`Safe world canvas: ${safe.width}x${safe.height}`);
    console.log(`World min: (${worldUnion.minX.toFixed(3)}, ${worldUnion.minY.toFixed(3)})`);
    console.log(`World max: (${worldUnion.maxX.toFixed(3)}, ${worldUnion.maxY.toFixed(3)})`);

    console.log("  Downscaled bounds scan (cepat) lalu dikonversi balik ke resolusi penuh");

    const DOWNSCALE = Number(process.env.BOUNDS_DOWNSCALE || 4);
    const PAD_EXTRA = Number(process.env.BOUNDS_PADDING || 16);

    const smallW = Math.max(1, Math.ceil(safe.width / DOWNSCALE));
    const smallH = Math.max(1, Math.ceil(safe.height / DOWNSCALE));

    const smallSurface = ck.MakeSurface(smallW, smallH);
    if (!smallSurface) throw new Error(`CanvasKit gagal membuat surface kecil ${smallW}x${smallH}`);
    const smallCanvas = smallSurface.getCanvas();
    const smallUnion = newUnion();
    const sim2 = createSequenceSimulator(skeletonData, sequence);
    const t2start = Date.now();

    for (let i = 0; i < totalFrames; i++) {
        const t = i / FPS;
        sim2.advanceTo(t);

        smallCanvas.save();
        smallCanvas.scale(1 / DOWNSCALE, 1 / DOWNSCALE);
        positionAndRender(ck, renderer, smallCanvas, sim2.drawable, safe.minX, safe.minY, ck.TRANSPARENT);
        smallCanvas.restore();

        const pngBytes = snapshotToPng(ck, smallSurface);
        const pixels = decodePng(pngBytes);
        unionVisiblePixels(smallUnion, pixels, smallW, smallH);
        printProgress(i + 1, totalFrames, t2start);
    }

    if (typeof smallSurface.delete === "function") smallSurface.delete();

    const pixelUnion = {
        minX: Math.max(0, Math.floor(smallUnion.minX * DOWNSCALE) - PAD_EXTRA),
        minY: Math.max(0, Math.floor(smallUnion.minY * DOWNSCALE) - PAD_EXTRA),
        maxX: Math.min(safe.width - 1, Math.ceil((smallUnion.maxX + 1) * DOWNSCALE) - 1 + PAD_EXTRA),
        maxY: Math.min(safe.height - 1, Math.ceil((smallUnion.maxY + 1) * DOWNSCALE) - 1 + PAD_EXTRA)
    };

    const finalBounds = makeEvenDimensions(pixelUnionToFinalBounds(pixelUnion, safe));

    console.log("========================================");
    console.log(`FINAL CANVAS: ${finalBounds.width}x${finalBounds.height}`);
    console.log(`FINAL ORIGIN: (${finalBounds.originX}, ${finalBounds.originY})`);
    console.log("Scale: 1.000000 (NO SCALE)");
    console.log("Crop: none outside global Action+Idle pixel union");
    console.log("========================================");

    return finalBounds;
}

async function runBoundsMode() {
    fs.mkdirSync(path.dirname(BOUNDS_FILE), { recursive: true });

    const ck = await CanvasKitInit();
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const renderer = new SkeletonRenderer(ck);

    const { sequence, totalFrames } = loadSequenceInfo(skeletonData);
    const finalBounds = await computeFinalBounds(ck, skeletonData, sequence, totalFrames, renderer);

    fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ finalBounds, totalFrames, fps: FPS }, null, 2));
    console.log(`Bounds ditulis ke ${BOUNDS_FILE}`);
}

async function runFramesMode() {
    const { finalBounds, totalFrames } = JSON.parse(fs.readFileSync(BOUNDS_FILE, "utf8"));
    const end = FRAME_END > 0 ? Math.min(FRAME_END, totalFrames) : totalFrames;

    fs.mkdirSync(FRAMES_OUT, { recursive: true });

    const ck = await CanvasKitInit();
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const renderer = new SkeletonRenderer(ck);
    const { sequence } = loadSequenceInfo(skeletonData);

    const sim = createSequenceSimulator(skeletonData, sequence);

    console.log(`Warm-up 0..${FRAME_START} (tanpa render)...`);
    for (let i = 0; i < FRAME_START; i++) {
        sim.advanceTo(i / FPS);
    }

    const surface = ck.MakeSurface(finalBounds.width, finalBounds.height);
    if (!surface) throw new Error(`CanvasKit gagal membuat surface ${finalBounds.width}x${finalBounds.height}`);
    const canvas = surface.getCanvas();
    const t0 = Date.now();
    const shardTotal = end - FRAME_START;

    console.log(`Rendering frame ${FRAME_START}..${end - 1} -> ${FRAMES_OUT}`);

    for (let i = FRAME_START; i < end; i++) {
        sim.advanceTo(i / FPS);

        positionAndRender(ck, renderer, canvas, sim.drawable, finalBounds.originX, finalBounds.originY, ck.BLACK);

        const pngBytes = snapshotToPng(ck, surface);
        const framePath = path.join(FRAMES_OUT, `frame_${String(i).padStart(6, "0")}.png`);
        fs.writeFileSync(framePath, pngBytes);

        printProgress(i - FRAME_START + 1, shardTotal, t0);
    }

    if (typeof surface.delete === "function") surface.delete();
    console.log(`Selesai: ${shardTotal} frame ditulis ke ${FRAMES_OUT}`);
}

async function runSingleMode() {
    console.log("========================================");
    console.log(" SPINE 4.2.120 -> ACTION + IDLE -> MP4");
    console.log("========================================");

    fs.mkdirSync(ROOT, { recursive: true });

    console.log("[1/7] Initializing CanvasKit...");
    const ck = await CanvasKitInit();

    console.log("[2/7] Loading atlas + skeleton...");
    const atlas = await loadTextureAtlas(ck, ATLAS, readFile);
    const skeletonData = await loadSkeletonData(JSON_FILE, atlas, readFile);
    const renderer = new SkeletonRenderer(ck);
    const { sequence, totalFrames } = loadSequenceInfo(skeletonData);

    const finalBounds = await computeFinalBounds(ck, skeletonData, sequence, totalFrames, renderer);

    console.log("[5/7] Creating final surface + FFmpeg...");
    console.log("  Frame transport: PNG image2pipe -> FFmpeg (no raw pixel readback)");

    const finalSurface = ck.MakeSurface(finalBounds.width, finalBounds.height);
    if (!finalSurface) throw new Error(`CanvasKit gagal membuat final surface ${finalBounds.width}x${finalBounds.height}`);
    const finalCanvas = finalSurface.getCanvas();

    const ff = startFFmpeg(finalBounds.width, finalBounds.height, OUTPUT);
    const sim3 = createSequenceSimulator(skeletonData, sequence);
    const t3start = Date.now();

    console.log("[6/7] Rendering MP4 frames...");

    for (let i = 0; i < totalFrames; i++) {
        const t = i / FPS;
        sim3.advanceTo(t);

        positionAndRender(ck, renderer, finalCanvas, sim3.drawable, finalBounds.originX, finalBounds.originY, ck.BLACK);

        const pngBytes = snapshotToPng(ck, finalSurface);

        if (!ff.stdin.write(pngBytes)) {
            await new Promise(resolve => ff.stdin.once("drain", resolve));
        }

        printProgress(i + 1, totalFrames, t3start);
    }

    ff.stdin.end();
    console.log("  Menunggu FFmpeg selesai encode ke MP4...");
    await waitForProcess(ff);

    if (typeof finalSurface.delete === "function") finalSurface.delete();

    console.log("[7/7] DONE");
    console.log("========================================");
    console.log(`Output : ${OUTPUT}`);
    console.log(`Size   : ${finalBounds.width}x${finalBounds.height}`);
    console.log(`FPS    : ${FPS}`);
    console.log(`Frames : ${totalFrames}`);
    console.log(`Time   : ${(totalFrames / FPS).toFixed(6)} sec`);
    console.log("Action: original duration, once");
    console.log("Idle  : original duration, once (NO LOOP)");
    console.log("Scale : 1:1");
    console.log("========================================");
}

async function main() {
    if (MODE === "bounds") {
        await runBoundsMode();
    } else if (MODE === "frames") {
        await runFramesMode();
    } else {
        await runSingleMode();
    }
}

main().catch(error => {
    console.error("\n========================================");
    console.error("MP4 RENDER ERROR");
    console.error("========================================");
    console.error(error?.stack || error);
    process.exit(1);
});
